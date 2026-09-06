import path from "node:path"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Global } from "@opencode-ai/core/global"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Layer } from "effect"
import { RexdError } from "./error"
import { testRexdConnection } from "./connection"
import { connectRexd } from "./connection"
import { detectRemotePlatform } from "./prepare"
import { RexdFiles } from "./location-files"
import { REXD_BASELINE_VERSION } from "./manifest"

export const rexdTargetRegistryNode = makeGlobalNode({
  service: TargetRegistry.Service,
  layer: Layer.effect(
    TargetRegistry.Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const probe: TargetRegistry.ConnectionProbe = {
        test: (target) => probeTarget(target, testInstalledRexdConnection, false),
        prepare: (target) => probeTarget(target),
        inspect: async (target) => ({ home: (await detectRemotePlatform({ ...target, id: "target-wizard" })).home }),
        complete: (target, input) => completeRemotePath(target, input),
      }
      return TargetRegistry.Service.of(
        TargetRegistry.make({
          directory: global.config,
          legacyFile: path.join(global.home, ".config", "rexd", "targets.json"),
          probe,
        }),
      )
    }),
  ),
  deps: [Global.node],
})

export async function probeTarget(
  target: TargetRegistry.Definition,
  test: (
    target: TargetRegistry.Definition,
    options: { directory?: string; clientVersion: string; signal?: AbortSignal },
  ) => Promise<unknown> = testRexdConnection,
  prepared = true,
): Promise<TargetRegistry.ProbeResult> {
  return test(target, {
    directory: target.defaultDirectory,
    clientVersion: InstallationVersion,
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
  target: TargetRegistry.Input,
  input: { readonly value: string; readonly cursor: number; readonly cwd: string },
) {
  const draft = { ...target, id: "target-wizard" }
  const home = (await detectRemotePlatform(draft)).home
  const prefix = input.value.slice(0, input.cursor)
  const expanded = prefix === "~" ? home : prefix.startsWith("~/") ? path.posix.join(home, prefix.slice(2)) : prefix
  const absolute = path.posix.isAbsolute(expanded) ? expanded : path.posix.join(input.cwd, expanded)
  const directory = absolute.endsWith("/") ? absolute : path.posix.dirname(absolute)
  const fragment = absolute.endsWith("/") ? "" : path.posix.basename(absolute)
  const lease = await connectRexd(draft, { clientVersion: InstallationVersion })
  const entries = await new RexdFiles("target-wizard", lease).list(directory, input.cwd).finally(() => lease.close())
  const candidates = entries
    .filter((entry) => entry.type === "dir" && entry.name.startsWith(fragment))
    .map((entry) => path.posix.join(directory, entry.name) + "/")
    .sort()
  const completion = candidates.slice(1).reduce((prefix, value) => {
    let index = 0
    while (index < prefix.length && prefix[index] === value[index]) index++
    return prefix.slice(0, index)
  }, candidates[0] ?? "")
  if (!completion) return { value: input.value, cursor: input.cursor, candidates }
  return { value: completion + input.value.slice(input.cursor), cursor: completion.length, candidates }
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
