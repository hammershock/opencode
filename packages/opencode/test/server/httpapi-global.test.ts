import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Layer, Option } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import { GlobalPaths } from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { testEffect } from "../lib/effect"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncMetadata } from "@opencode-ai/core/sync/metadata"

const remoteSession = SyncMetadata.Item.make({
  sessionID: "ses_remote",
  title: "Remote session",
  ownerDeviceID: "device_remote",
  targetLabel: "lab",
  directory: "/workspace",
  revision: 1,
  updatedAt: 1,
  sourceDeviceID: "device_remote",
  availability: "metadata-only",
})

const apiLayer = HttpRouter.serve(
  HttpApiBuilder.layer(RootHttpApi).pipe(
    Layer.provide([controlHandlers, controlPlaneHandlers, globalHandlers]),
    Layer.provide([authorizationLayer, schemaErrorLayer]),
    // Raw HttpApi routes expose an opaque handler context at the request boundary.
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    HttpRouter.provideRequest(Layer.succeedContext(Context.empty() as Context.Context<unknown>)),
  ),
  { disableListenLog: true, disableLogger: true },
).pipe(
  Layer.provideMerge(NodeHttpServer.layerTest),
  Layer.provide(Layer.mock(Auth.Service)({})),
  Layer.provide(Layer.mock(Config.Service)({})),
  Layer.provide(Layer.mock(MoveSession.Service)({})),
  Layer.provide(
    Layer.mock(SyncSetup.Service)({
      config: () => Effect.succeed(undefined),
      inspectLegacy: () => Effect.succeed({ available: false }),
    }),
  ),
  Layer.provide(
    Layer.mock(SyncControl.Service)({
      status: () =>
        Effect.succeed(
          SyncControl.Status.make({ configured: false, enabled: false, locked: false, outbox: 0, cursors: {} }),
        ),
      sessions: () => Effect.succeed([remoteSession]),
      hydrate: (input) => Effect.succeed(SyncControl.HydrateResult.make({ ...input, availability: "ready" })),
    }),
  ),
  Layer.provide(
    Layer.mock(Installation.Service)({
      method: () => Effect.succeed("npm"),
      latest: () => Effect.succeed("9.9.9"),
      upgrade: () => Effect.void,
    }),
  ),
  Layer.provide(ServerAuth.Config.configLayer({ password: Option.none(), username: "opencode" })),
)
const it = testEffect(apiLayer)

describe("global HttpApi", () => {
  it.live("reports redacted sync control status", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.syncStatus).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        configured: false,
        enabled: false,
        locked: false,
        outbox: 0,
        cursors: {},
      })
    }),
  )

  it.live("lists metadata-only sessions and hydrates a selected session", () =>
    Effect.gen(function* () {
      const sessions = yield* HttpClientRequest.get(GlobalPaths.syncSessions).pipe(HttpClient.execute)
      expect(sessions.status).toBe(200)
      expect(yield* sessions.json).toEqual([remoteSession])

      const hydrate = yield* HttpClientRequest.post(GlobalPaths.syncHydrate).pipe(
        HttpClientRequest.bodyJsonUnsafe({ sessionID: remoteSession.sessionID }),
        HttpClient.execute,
      )
      expect(hydrate.status).toBe(200)
      expect(yield* hydrate.json).toEqual({ sessionID: remoteSession.sessionID, availability: "ready" })
    }),
  )

  it.live("upgrades to the requested version", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "9.9.9" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({ success: true, version: "9.9.9" })
    }),
  )

  it.live("rejects invalid upgrade payloads", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: 1 }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects invalid upgrade target versions", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.bodyJsonUnsafe({ target: "latest" }),
        HttpClient.execute,
      )

      expect(response.status).toBe(400)
    }),
  )

  it.live("rejects unsupported upgrade content types", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.upgrade).pipe(
        HttpClientRequest.setBody(HttpBody.text('{"target":"1.0.0"}', "text/plain")),
        HttpClient.execute,
      )

      expect(response.status).toBe(415)
    }),
  )
})
