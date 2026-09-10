import path from "node:path"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Global } from "@opencode-ai/core/global"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Layer } from "effect"
import { RexdError } from "./error"
import { testRexdConnection } from "./connection"
import { connectRexd, type RexdLease } from "./connection"
import { detectRemotePlatform } from "./prepare"
import { RexdFiles } from "./location-files"
import { REXD_BASELINE_VERSION } from "./manifest"
import { Database } from "@opencode-ai/core/database/database"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { RexdConnectionPool } from "./connection-pool"

export const TARGET_HEALTH_TIMEOUT_MS = 8_000

export const rexdTargetRegistryNode = makeGlobalNode({
  service: TargetRegistry.Service,
  layer: Layer.effect(
    TargetRegistry.Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const db = (yield* Database.Service).db
      const pool = yield* RexdConnectionPool.Service
      const pooled = async (
        target: TargetRegistry.Definition,
        options: { directory?: string; clientVersion: string; signal?: AbortSignal },
      ) => {
        const handle = await pool.acquire(target, options)
        await handle.release()
        return { handshake: handle.lease.handshake, prepared: handle.lease.prepared }
      }
      const wizard = yield* Effect.acquireRelease(
        Effect.sync(() =>
          makeWizardConnectionProbe({
            connect: async (target, options) => {
              const handle = await pool.acquire(target, options)
              return { ...handle.lease, close: handle.release }
            },
          }),
        ),
        (current) => Effect.promise(() => current.close()),
      )
      const probe: TargetRegistry.ConnectionProbe = {
        test: (target) =>
          targetHealthWithDeadline((signal) =>
            probeTarget(target, testInstalledRexdConnection, false, target.defaultDirectory, signal),
          ),
        prepare: (target, directory) => probeTarget(target, pooled, true, directory),
        inspect: wizard.inspect,
        complete: wizard.complete,
      }
      return TargetRegistry.Service.of(
        TargetRegistry.make({
          directory: global.config,
          legacyFile: path.join(global.home, ".config", "rexd", "targets.json"),
          probe,
          restoreAuthorizer: {
            authorize: async (targetID, referencedSessionIDs) => {
              const rows = await Effect.runPromise(
                db.select({ id: SessionTable.id, target: SessionTable.target }).from(SessionTable),
              )
              const actual = rows
                .filter((row) => row.target?.type === "rexd" && row.target.targetID === targetID)
                .map((row) => row.id)
                .sort()
              const expected = [...new Set(referencedSessionIDs)].sort()
              return (
                actual.length > 0 &&
                actual.length === expected.length &&
                actual.every((id, index) => id === expected[index])
              )
            },
          },
        }),
      )
    }),
  ),
  deps: [Global.node, Database.node, RexdConnectionPool.node],
})

type WizardConnection = {
  readonly lease: RexdLease
  readonly home: string
}

type WizardEntry = {
  readonly connection: Promise<WizardConnection>
  users: number
  timer?: ReturnType<typeof setTimeout>
  closed: boolean
}

export function makeWizardConnectionProbe(
  dependencies: {
    readonly connect?: typeof connectRexd
    readonly detect?: typeof detectRemotePlatform
    readonly idleMs?: number
  } = {},
) {
  const entries = new Map<string, WizardEntry>()
  const connect = dependencies.connect ?? connectRexd
  const detect = dependencies.detect ?? detectRemotePlatform
  const idleMs = dependencies.idleMs ?? 2 * 60_000

  const evict = (key: string, entry: WizardEntry) => {
    if (entry.closed) return Promise.resolve()
    entry.closed = true
    if (entries.get(key) === entry) entries.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    return entry.connection.then((value) => value.lease.close()).catch(() => undefined)
  }

  const use = async <T>(target: TargetRegistry.Input, run: (connection: WizardConnection) => Promise<T>) => {
    const key = wizardConnectionKey(target)
    const current = entries.get(key)
    const entry =
      current ??
      (() => {
        const created: WizardEntry = {
          connection: openWizardConnection(target, connect, detect),
          users: 0,
          closed: false,
        }
        entries.set(key, created)
        return created
      })()
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.users++
    try {
      return await run(await entry.connection)
    } catch (error) {
      void evict(key, entry)
      throw error
    } finally {
      entry.users--
      if (entry.users === 0 && !entry.closed) {
        entry.timer = setTimeout(() => void evict(key, entry), idleMs)
        entry.timer.unref?.()
      }
    }
  }

  return {
    inspect: (target: TargetRegistry.Input) => use(target, async (connection) => ({ home: connection.home })),
    complete: (
      target: TargetRegistry.Input,
      input: { readonly value: string; readonly cursor: number; readonly cwd: string },
    ) => use(target, (connection) => completeRemotePath(connection, input)),
    close: async () => {
      const active = [...entries.entries()]
      await Promise.allSettled(active.map(([key, entry]) => evict(key, entry)))
    },
  }
}

export async function probeTarget(
  target: TargetRegistry.Definition,
  test: (
    target: TargetRegistry.Definition,
    options: { directory?: string; clientVersion: string; signal?: AbortSignal },
  ) => Promise<unknown> = testRexdConnection,
  prepared = true,
  directory = target.defaultDirectory,
  signal?: AbortSignal,
): Promise<TargetRegistry.ProbeResult> {
  return test(target, {
    directory,
    clientVersion: InstallationVersion,
    signal,
  })
    .then(
      () =>
        ({
          status: "ready",
          stages: [
            "ssh",
            "environment",
            ...(prepared ? (["prepare"] as const) : []),
            "handshake",
            "capabilities",
            "directory",
          ],
        }) satisfies TargetRegistry.ProbeResult,
    )
    .catch((error: unknown) => ({
      status: error instanceof RexdError && !error.retryable ? ("invalid" as const) : ("unavailable" as const),
      stage: stage(error),
      message: error instanceof Error ? error.message : "Rexd target probe failed",
    }))
}

export async function targetHealthWithDeadline(
  probe: (signal: AbortSignal) => Promise<TargetRegistry.ProbeResult>,
  timeoutMs = TARGET_HEALTH_TIMEOUT_MS,
) {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<TargetRegistry.ProbeResult>((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("Target health check timed out", "TimeoutError"))
      resolve({
        status: "unavailable",
        stage: "ssh",
        message: `SSH connection timed out after ${timeoutMs / 1_000} seconds`,
      })
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([probe(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function testInstalledRexdConnection(
  target: TargetRegistry.Definition,
  options: { directory?: string; clientVersion: string; signal?: AbortSignal },
) {
  if (target.command) return testRexdConnection(target, options)
  const remote = await detectRemotePlatform(target, options.signal)
  return testRexdConnection(
    {
      ...target,
      command: {
        program: `${remote.dataHome}/opencode/rexd/${REXD_BASELINE_VERSION}/rexd`,
        args: ["--stdio", "--config", `${remote.configHome}/opencode/rexd/config.toml`],
      },
    },
    options,
  )
}

async function completeRemotePath(
  connection: WizardConnection,
  input: { readonly value: string; readonly cursor: number; readonly cwd: string },
) {
  const prefix = input.value.slice(0, input.cursor)
  const expanded =
    prefix === "~"
      ? connection.home
      : prefix.startsWith("~/")
        ? path.posix.join(connection.home, prefix.slice(2))
        : prefix
  const absolute = path.posix.isAbsolute(expanded) ? expanded : path.posix.join(input.cwd, expanded)
  const directory = absolute.endsWith("/") ? absolute : path.posix.dirname(absolute)
  const fragment = absolute.endsWith("/") ? "" : path.posix.basename(absolute)
  const files = new RexdFiles("target-wizard", connection.lease)
  const entries = await files.list(directory, input.cwd)
  const candidates = (
    await Promise.all(
      entries
        .filter((entry) => entry.name.startsWith(fragment) && (entry.type === "dir" || entry.type === "symlink"))
        .map(async (entry) => {
          const candidate = path.posix.join(directory, entry.name)
          if (entry.type === "dir") return candidate + "/"
          return (await files.directoryStatus(candidate, input.cwd)).status === "directory"
            ? candidate + "/"
            : undefined
        }),
    )
  )
    .filter((candidate) => candidate !== undefined)
    .sort()
  const completion = candidates.slice(1).reduce((prefix, value) => {
    let index = 0
    while (index < prefix.length && prefix[index] === value[index]) index++
    return prefix.slice(0, index)
  }, candidates[0] ?? "")
  if (!completion) return { value: input.value, cursor: input.cursor, candidates }
  return { value: completion + input.value.slice(input.cursor), cursor: completion.length, candidates }
}

async function openWizardConnection(
  target: TargetRegistry.Input,
  connect: typeof connectRexd,
  detect: typeof detectRemotePlatform,
): Promise<WizardConnection> {
  const draft = { ...target, id: "target-wizard", workspaceRoots: ["/"] }
  const lease = await connect(draft, { clientVersion: InstallationVersion })
  const home =
    lease.prepared?.home ??
    (await detect(draft).then(
      (remote) => remote.home,
      async (error) => {
        await lease.close()
        throw error
      },
    ))
  return {
    lease,
    home,
  }
}

function wizardConnectionKey(target: TargetRegistry.Input) {
  const connection =
    target.connection.type === "ssh-config"
      ? [target.connection.type, target.connection.host]
      : [
          target.connection.type,
          target.connection.host,
          target.connection.user,
          target.connection.port,
          target.connection.identityFile ?? null,
        ]
  return JSON.stringify([connection, target.command ? [target.command.program, target.command.args] : null])
}

function stage(error: unknown): TargetRegistry.ConnectionStage {
  if (!(error instanceof RexdError)) return "ssh"
  if (error.phase === "detect") return "environment"
  if (error.phase === "download" || error.phase === "checksum" || error.phase === "install") return "prepare"
  if (error.phase === "handshake") return "handshake"
  if (error.phase === "capability") return "capabilities"
  if (error.phase === "directory") return "directory"
  return "ssh"
}
