import { describe, expect } from "bun:test"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRuntime } from "@opencode-ai/core/sync/runtime"
import { SyncCodec } from "@opencode-ai/core/sync/codec"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { Config, Context, Effect, Layer } from "effect"
import { eq } from "drizzle-orm"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import { layerWebSocketConstructorGlobal } from "effect/unstable/socket/Socket"
import { InstanceStore } from "@/project/instance-store"
import { Project } from "@/project/project"
import { Session } from "@/session/session"
import { Workspace } from "@/control-plane/workspace"
import { InstanceBootstrap as InstanceBootstrapService } from "@/project/bootstrap-service"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { SessionPaths } from "@/server/routes/instance/httpapi/groups/session"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { TestInstance } from "../fixture/fixture"

const spaceID = "space-production-http"
const noopBootstrapLayer = Layer.succeed(
  InstanceBootstrapService.Service,
  InstanceBootstrapService.Service.of({ run: Effect.void }),
)
const servedRoutes: Layer.Layer<never, Config.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  {
    disableListenLog: true,
    disableLogger: true,
  },
)
const httpApiLayer = servedRoutes.pipe(
  Layer.provide(layerWebSocketConstructorGlobal),
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provideMerge(NodeServices.layer),
)

function setupLayer(active: boolean) {
  return Layer.mock(SyncSetup.Service, {
    config: () =>
      Effect.succeed(
        active
          ? {
              provider: "baidu" as const,
              deviceID: "mac",
              deviceName: "Mac",
              account: { id: "account", maskedDisplay: "acc***" },
              namespaceID: spaceID,
              name: "Production",
              encryption: "none" as const,
              remoteRoot: `/apps/opencode-sync/spaces/${spaceID}`,
              enabled: true,
              intervalSeconds: 60 as const,
            }
          : undefined,
      ),
  })
}

function application(active: boolean) {
  return AppNodeBuilder.build(
    LayerNode.group([
      InstanceStore.node,
      Project.node,
      Session.node,
      Workspace.node,
      Database.node,
      SyncEventStore.node,
      Ripgrep.node,
    ]),
    [
      [InstanceStore.bootstrapNode, noopBootstrapLayer],
      [Database.node, Database.layerFromPath(":memory:")],
      [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
      [SyncSetup.node, setupLayer(active)],
    ],
  )
}

function request(directory: string) {
  const url = new URL(SessionPaths.create, "http://localhost")
  return HttpClientRequest.fromWeb(
    new Request(url, {
      method: "POST",
      headers: { "x-opencode-directory": directory, "content-type": "application/json" },
      body: JSON.stringify({ title: "created through production HTTP" }),
    }),
  ).pipe(HttpClientRequest.setUrl(url.pathname), HttpClient.execute)
}

function suite(active: boolean) {
  return testEffect(Layer.mergeAll(application(active), httpApiLayer))
}

function memoryProvider() {
  const files = new Map<string, { bytes: Uint8Array; version: number }>()
  const adapter: SyncProvider.Adapter = {
    id: "memory",
    list: async (prefix) => ({
      objects: [...files]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, value]) => ({ path, version: String(value.version), size: value.bytes.length })),
    }),
    stat: async (path) => {
      const value = files.get(path)
      return value && { path, version: String(value.version), size: value.bytes.length }
    },
    download: async (path, version) => {
      const value = files.get(path)
      if (!value || (version && version !== String(value.version))) throw new Error("missing")
      return { path, version: String(value.version), size: value.bytes.length, bytes: value.bytes }
    },
    uploadAtomic: async (path, bytes, precondition) => {
      const current = files.get(path)
      if (precondition.type === "absent" && current) throw new Error("exists")
      if (precondition.type === "version" && String(current?.version) !== precondition.version)
        throw new Error("conflict")
      const value = { bytes: bytes.slice(), version: (current?.version ?? 0) + 1 }
      files.set(path, value)
      return { path, version: String(value.version), size: bytes.length }
    },
    deleteBatch: async () => [],
  }
  return adapter
}

describe("production legacy Session sync assignment", () => {
  suite(true).instance(
    "persists the exact active space and exposes the Created event to sync capture",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const response = yield* request(test.directory)
        expect(response.status).toBe(200)
        const created = (yield* response.json) as Session.Info
        expect(created.syncSpaceID).toBe(spaceID)

        const database = yield* Database.Service
        const row = yield* database.db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        expect(row?.sync_space_id).toBe(spaceID)

        const store = yield* SyncEventStore.Service
        const captured = yield* pollWithTimeout(
          store
            .scope(spaceID)
            .pending(10)
            .pipe(Effect.map((events) => events.find((event) => event.aggregateID === created.id))),
          "legacy HTTP Session was not captured in its active sync space",
        )
        expect(captured?.data.info).toMatchObject({ id: created.id, syncSpaceID: spaceID })
        expect(yield* store.pending(10)).toEqual([])

        const provider = memoryProvider()
        const source = SyncRuntime.make({
          config: { deviceID: SyncEvent.DeviceID.make("mac"), deviceName: "Mac", enabled: true },
          codec: SyncCodec.plaintext(),
          provider,
          store: store.scope(spaceID),
          projector: { project: () => Effect.void, delete: () => Effect.void },
          metadata: () =>
            Effect.succeed([
              {
                sessionID: created.id,
                title: created.title,
                ownerDeviceID: "mac",
                directory: created.directory,
                revision: 0,
                updatedAt: created.time.updated,
              },
            ]),
          metadataProjector: { apply: () => Effect.void },
        })
        const targetContext = yield* Layer.build(
          SyncEventStore.layer.pipe(Layer.provide(SyncDatabase.layerFromPath(":memory:"))),
        )
        const discovered: SyncRuntime.Metadata[] = []
        const target = SyncRuntime.make({
          config: { deviceID: SyncEvent.DeviceID.make("mywindows"), deviceName: "mywindows", enabled: true },
          codec: SyncCodec.plaintext(),
          provider,
          store: Context.get(targetContext, SyncEventStore.Service).scope(spaceID),
          projector: { project: () => Effect.void, delete: () => Effect.void },
          metadata: () => Effect.succeed([]),
          metadataProjector: { apply: (items) => Effect.sync(() => void discovered.push(...items)) },
        })
        yield* source.upload()
        yield* target.pull()
        expect(discovered).toContainEqual(expect.objectContaining({ sessionID: created.id, title: created.title }))
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )

  suite(false).instance(
    "keeps legacy HTTP Sessions unassigned when there is no active space",
    () =>
      Effect.gen(function* () {
        const test = yield* TestInstance
        const response = yield* request(test.directory)
        expect(response.status).toBe(200)
        const created = (yield* response.json) as Session.Info
        expect(created.syncSpaceID).toBeUndefined()

        const database = yield* Database.Service
        const row = yield* database.db
          .select()
          .from(SessionTable)
          .where(eq(SessionTable.id, created.id))
          .get()
          .pipe(Effect.orDie)
        expect(row?.sync_space_id).toBeNull()
        expect(yield* (yield* SyncEventStore.Service).scope(spaceID).pending(10)).toEqual([])
      }),
    { git: true, config: { formatter: false, lsp: false } },
  )
})
