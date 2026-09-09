import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises"
import path from "node:path"
import { createInterface } from "node:readline"
import { Context, Effect, Layer } from "effect"
import { eq, sql } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Global } from "@opencode-ai/core/global"
import { ProjectV2 } from "@opencode-ai/core/project"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { PartTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRoot } from "@opencode-ai/core/sync/root"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { Flock } from "@opencode-ai/core/util/flock"
import { SessionV1 } from "@opencode-ai/core/v1/session"

type Input = {
  readonly workerID: string
  readonly deviceID: string
  readonly deviceRoot: string
  readonly cloudRoot: string
}

type Command =
  | { readonly id: string; readonly op: "create"; readonly sessionID: string; readonly title: string }
  | { readonly id: string; readonly op: "update"; readonly sessionID: string; readonly title: string }
  | { readonly id: string; readonly op: "delete"; readonly sessionID: string }
  | { readonly id: string; readonly op: "query"; readonly sessionID: string }
  | { readonly id: string; readonly op: "expire-automatic-lease" }

const value = process.argv[2]
if (!value) throw new Error("usage: sync-control-worker <json>")
const input = JSON.parse(value) as Input
const spaceID = SyncRoot.accountScope("multiprocess")

function emit(message: object) {
  process.stdout.write(JSON.stringify(message) + "\n")
}

function providerError(operation: "download" | "upload", kind: "not-found" | "conflict") {
  return new SyncProvider.ProviderError("filesystem", operation, kind, false)
}

function filesystemProvider(): SyncProvider.Adapter {
  const locks = path.join(input.cloudRoot, ".locks")
  const absolute = (object: string) => path.join(input.cloudRoot, ...SyncProvider.objectPath(object).split("/"))
  const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
  const info = async (object: string): Promise<SyncProvider.ObjectInfo | undefined> => {
    const file = absolute(object)
    const metadata = await stat(file).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return
      throw cause
    })
    if (!metadata?.isFile()) return
    const bytes = new Uint8Array(await readFile(file))
    return { path: object, version: digest(bytes), size: bytes.length, modifiedAt: metadata.mtimeMs }
  }
  const audit = (operation: string, object: string) =>
    emit({ type: "provider-call", workerID: input.workerID, deviceID: input.deviceID, operation, path: object })
  const scan = async (directory: string): Promise<string[]> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ENOTDIR") return []
      throw cause
    })
    const nested = await Promise.all(
      entries
        .filter((entry) => entry.name !== ".locks" && !entry.name.includes(".tmp-"))
        .map(async (entry) => {
          const item = path.join(directory, entry.name)
          return entry.isDirectory() ? scan(item) : [item]
        }),
    )
    return nested.flat()
  }
  const list = async (prefix: string) => {
    audit("list", prefix)
    const files = await scan(absolute(prefix))
    const objects = await Promise.all(
      files.map(async (file) => {
        const object = path.relative(input.cloudRoot, file).split(path.sep).join("/")
        return (await info(object))!
      }),
    )
    return { objects }
  }
  return {
    id: "filesystem",
    list,
    listRecursive: list,
    async stat(object) {
      audit("stat", object)
      return info(object)
    },
    async download(object, version) {
      audit("download", object)
      const current = await info(object)
      if (!current) throw providerError("download", "not-found")
      if (version && version !== current.version) throw providerError("download", "conflict")
      return { ...current, bytes: new Uint8Array(await readFile(absolute(object))) }
    },
    async uploadAtomic(object, bytes, precondition) {
      audit("upload", object)
      return Flock.withLock(
        object,
        async () => {
          const current = await info(object)
          if (precondition.type === "absent" && current) throw providerError("upload", "conflict")
          if (precondition.type === "version" && current?.version !== precondition.version)
            throw providerError("upload", "conflict")
          const file = absolute(object)
          const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`
          await mkdir(path.dirname(file), { recursive: true })
          await writeFile(temporary, bytes)
          await rename(temporary, file)
          return (await info(object))!
        },
        { dir: locks, staleMs: 5_000, timeoutMs: 10_000, baseDelayMs: 5, maxDelayMs: 25 },
      )
    },
    async deleteBatch(objects) {
      audit("delete", objects.map((item) => item.path).join(","))
      return Promise.all(
        objects.map((object) =>
          Flock.withLock(
            object.path,
            async () => {
              const current = await info(object.path)
              if (!current) return { path: object.path, status: "missing" as const }
              if (object.version && object.version !== current.version)
                return { path: object.path, status: "conflict" as const, version: current.version }
              await unlink(absolute(object.path))
              return { path: object.path, status: "deleted" as const }
            },
            { dir: locks, staleMs: 5_000, timeoutMs: 10_000, baseDelayMs: 5, maxDelayMs: 25 },
          ),
        ),
      )
    },
  }
}

const account = { id: "test-account", maskedDisplay: "tes***" }
const descriptor = {
  namespaceID: spaceID,
  name: "Session sync",
  protocol: { major: 1 as const, minor: 0 },
  encryption: "none" as const,
  createdAt: 1,
  updatedAt: 1,
  summary: { sessions: 0, devices: 2, updatedAt: 1 },
  revision: 1,
}
const state = {
  version: 2 as const,
  revision: 1,
  provider: "baidu" as const,
  deviceID: input.deviceID,
  deviceName: input.deviceID,
  account,
  activeSpaceID: spaceID,
  enabled: true,
  intervalSeconds: 30 as const,
  spaces: [{ accountID: account.id, descriptor, remoteRoot: SyncRoot.instanceRoot("multiprocess"), joinedAt: 1 }],
}
const active = {
  provider: "baidu" as const,
  deviceID: input.deviceID,
  deviceName: input.deviceID,
  account,
  namespaceID: spaceID,
  name: descriptor.name,
  encryption: descriptor.encryption,
  remoteRoot: SyncRoot.instanceRoot("multiprocess"),
  enabled: true,
  intervalSeconds: 30 as const,
}

await mkdir(input.deviceRoot, { recursive: true })
await mkdir(input.cloudRoot, { recursive: true })

const secrets = new Map([
  [
    BaiduSyncProvider.credentialAccount(input.deviceID),
    JSON.stringify({
      appKey: "test-app",
      secretKey: "test-secret",
      accessToken: "test-access",
      refreshToken: "test-refresh",
      expiresAt: Number.MAX_SAFE_INTEGER,
    }),
  ],
])
const secureStore: SyncSecureStore.Store = {
  platform: "macos-keychain",
  get: async (key) => secrets.get(key),
  set: async (key, secret) => void secrets.set(key, secret),
  remove: async (key) => void secrets.delete(key),
}
const setupLayer = Layer.mock(SyncSetup.Service, {
  state: () => Effect.succeed(state),
  config: () => Effect.succeed(active),
  authenticated: () => Effect.succeed(true),
  cloudStatus: () =>
    Effect.succeed({
      status: "ready" as const,
      manifest: {
        version: 2 as const,
        state: "ready" as const,
        protocol: { major: 1 as const, minor: 0 },
        instanceID: "multiprocess",
        createdAt: 1,
      },
    }),
  applyRemoteDeletion: () => Effect.succeed(false),
})
const controlNode = {
  ...SyncControl.node,
  implementation: SyncControl.layerWith({ secureStore: async () => secureStore, provider: filesystemProvider }),
}
const globalRoot = {
  home: input.deviceRoot,
  data: path.join(input.deviceRoot, "data"),
  config: path.join(input.deviceRoot, "config"),
  state: path.join(input.deviceRoot, "state"),
  cache: path.join(input.deviceRoot, "cache"),
  tmp: path.join(input.deviceRoot, "tmp"),
  bin: path.join(input.deviceRoot, "bin"),
  log: path.join(input.deviceRoot, "log"),
  repos: path.join(input.deviceRoot, "repos"),
}
await Promise.all(
  Object.values(globalRoot)
    .slice(1)
    .map((directory) => mkdir(directory, { recursive: true })),
)
const layer = LayerNode.compile(
  LayerNode.group([
    controlNode,
    SessionProjector.node,
    EventV2.node,
    Database.node,
    SyncDatabase.node,
    SyncEventStore.node,
  ]),
  [
    [Global.node, Global.layerWith(globalRoot)],
    [Database.node, Database.layerFromPath(path.join(input.deviceRoot, "session.db"))],
    [SyncDatabase.node, SyncDatabase.layerFromPath(path.join(input.deviceRoot, "sync.db"))],
    [SyncSetup.node, setupLayer],
  ],
)

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const context = yield* Layer.build(layer)
      const events = Context.get(context, EventV2.Service)
      const database = Context.get(context, Database.Service).db
      const syncDatabase = Context.get(context, SyncDatabase.Service).db
      const store = Context.get(context, SyncEventStore.Service).scope(spaceID)
      const control = Context.get(context, SyncControl.Service)

      yield* events.listen((event) =>
        Effect.sync(() =>
          emit({
            type: "event",
            workerID: input.workerID,
            deviceID: input.deviceID,
            eventType: event.type,
            aggregateID: event.durable?.aggregateID,
          }),
        ),
      )
      emit({ type: "ready", workerID: input.workerID, deviceID: input.deviceID, pid: process.pid })

      yield* Effect.promise(async () => {
        const reader = createInterface({ input: process.stdin })
        for await (const line of reader) {
          if (!line.trim()) continue
          const command = JSON.parse(line) as Command
          try {
            if (command.op === "create") {
              const sessionID = SessionV2.ID.make(command.sessionID)
              const timestamp = Date.now()
              const event = await Effect.runPromise(
                events.publish(SessionV1.Event.Created, {
                  sessionID,
                  info: {
                    id: sessionID,
                    slug: command.sessionID,
                    projectID: ProjectV2.ID.make("global"),
                    directory: `/workspace/${input.deviceID}`,
                    syncSpaceID: spaceID,
                    title: command.title,
                    version: "test",
                    time: { created: timestamp, updated: timestamp },
                  },
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, event, timestamp))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "query") {
              const sessionID = SessionV2.ID.make(command.sessionID)
              const session = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
              )
              const parts = await Effect.runPromise(
                database
                  .select({ data: PartTable.data })
                  .from(PartTable)
                  .where(eq(PartTable.session_id, sessionID))
                  .all(),
              )
              const cursors = await Effect.runPromise(
                syncDatabase.all<{ device_id: string; cursor: number }>(
                  sql`SELECT device_id, cursor FROM sync_event_cursor WHERE space_id = ${spaceID}`,
                ),
              )
              const lease = await Effect.runPromise(
                syncDatabase.get<{ owner: string; expires_at: number }>(
                  sql`SELECT owner, expires_at FROM sync_event_lease WHERE name = ${`${spaceID}:automatic`}`,
                ),
              )
              emit({
                type: "response",
                id: command.id,
                ok: true,
                result: {
                  session: session ? { id: session.id, title: session.title } : undefined,
                  parts,
                  cursors,
                  lease,
                },
              })
              continue
            }
            if (command.op === "update") {
              const sessionID = SessionV2.ID.make(command.sessionID)
              const current = await Effect.runPromise(
                database.select().from(SessionTable).where(eq(SessionTable.id, sessionID)).get(),
              )
              if (!current) throw new Error(`Session not found: ${sessionID}`)
              const timestamp = Date.now()
              const event = await Effect.runPromise(
                events.publish(SessionV1.Event.Updated, {
                  sessionID,
                  info: {
                    id: sessionID,
                    slug: current.slug,
                    projectID: current.project_id,
                    directory: current.directory,
                    syncSpaceID: spaceID,
                    title: command.title,
                    version: current.version,
                    time: { created: current.time_created, updated: timestamp },
                  },
                }),
              )
              await Effect.runPromise(SessionSync.capture(store, event, timestamp))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            if (command.op === "delete") {
              await Effect.runPromise(control.deleteSession({ sessionID: command.sessionID }))
              emit({ type: "response", id: command.id, ok: true })
              continue
            }
            await Effect.runPromise(
              syncDatabase.run(sql`UPDATE sync_event_lease SET expires_at = 0 WHERE name = ${`${spaceID}:automatic`}`),
            )
            emit({ type: "response", id: command.id, ok: true })
          } catch (cause) {
            emit({ type: "response", id: command.id, ok: false, error: String(cause) })
          }
        }
      })
    }),
  ),
).catch((cause) => {
  emit({ type: "fatal", workerID: input.workerID, deviceID: input.deviceID, error: String(cause) })
  process.exitCode = 1
})
