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
import { SyncState } from "@opencode-ai/core/sync/state"
import { SyncSpace } from "@opencode-ai/core/sync/space"

const descriptor = SyncSpace.Descriptor.make({
  namespaceID: "space-a",
  name: "Space A",
  protocol: { major: 1, minor: 0 },
  encryption: "none",
  createdAt: 1,
  updatedAt: 1,
  summary: { sessions: 0, devices: 1, updatedAt: 1 },
  revision: 1,
})
const syncState = SyncState.State.make({
  version: 2,
  revision: 1,
  provider: "baidu",
  deviceID: "device-a",
  deviceName: "Mac",
  account: { id: "account-a", maskedDisplay: "ha***@example.com" },
  activeSpaceID: descriptor.namespaceID,
  enabled: true,
  intervalSeconds: 30,
  spaces: [{ accountID: "account-a", descriptor, remoteRoot: "spaces/space-a", joinedAt: 1 }],
})

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
      state: () => Effect.succeed(syncState),
      initialize: () => Effect.succeed(syncState),
      begin: (input) =>
        Effect.succeed({ attemptID: "attempt-a", authorizationURL: input.redirectURI, completion: input.completion }),
      complete: () => Effect.succeed(syncState),
      switchAccount: () => Effect.succeed(syncState),
      logout: () => Effect.succeed(syncState),
      discover: () => Effect.succeed({ spaces: [{ status: "compatible", descriptor }], deletions: [] }),
      create: () => Effect.succeed({ state: syncState, descriptor }),
      join: () => Effect.succeed(syncState),
      activate: () => Effect.succeed(syncState),
      leave: () => Effect.succeed(syncState),
      setEnabled: () => Effect.succeed(syncState),
      setInterval: () => Effect.succeed(syncState),
      deleteSpace: (namespaceID) => Effect.succeed(namespaceID),
      removeFromDevice: () => Effect.succeed([descriptor.namespaceID]),
    }),
  ),
  Layer.provide(
    Layer.mock(SyncControl.Service)({
      status: () =>
        Effect.succeed(
          SyncControl.Status.make({
            configured: false,
            initialized: false,
            authenticated: false,
            enabled: false,
            locked: false,
            outbox: 0,
            cursors: {},
          }),
        ),
      sessions: () => Effect.succeed([remoteSession]),
      hydrate: (input) => Effect.succeed(SyncControl.HydrateResult.make({ ...input, availability: "ready" })),
      switchAccount: () => Effect.succeed(syncState),
      logout: () => Effect.void,
      switchSpace: (input) =>
        Effect.succeed(
          input.namespaceID === "blocked"
            ? SyncControl.SwitchResult.make({ status: "blocked", reason: "pending-outbox", outbox: 2 })
            : SyncControl.SwitchResult.make({ status: "switched", namespaceID: input.namespaceID }),
        ),
      leaveSpace: () => Effect.succeed(["session-a"]),
      enable: () => Effect.void,
      setInterval: () => Effect.void,
      deleteSpace: () => Effect.succeed(["session-a"]),
      removeFromDevice: () => Effect.succeed(["session-a"]),
      unassigned: () => Effect.succeed(["session-unassigned"]),
      assignUnassigned: (input) => Effect.succeed(input.sessionIDs),
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
  it.live("exposes the account and multi-space setup lifecycle", () =>
    Effect.gen(function* () {
      const state = yield* HttpClientRequest.get(GlobalPaths.syncState).pipe(HttpClient.execute)
      expect(state.status).toBe(200)
      expect(yield* state.json).toEqual(syncState)

      const requests = [
        HttpClientRequest.post(GlobalPaths.syncInitialize).pipe(
          HttpClientRequest.bodyJsonUnsafe({ deviceName: "Mac" }),
        ),
        HttpClientRequest.post(GlobalPaths.syncOAuthBegin).pipe(
          HttpClientRequest.bodyJsonUnsafe({ redirectURI: "http://127.0.0.1/callback", completion: "loopback" }),
        ),
        HttpClientRequest.post(GlobalPaths.syncOAuthComplete).pipe(
          HttpClientRequest.bodyJsonUnsafe({ attemptID: "attempt-a", response: { type: "manual", code: "code" } }),
        ),
        HttpClientRequest.post(GlobalPaths.syncOAuthSwitchAccount).pipe(
          HttpClientRequest.bodyJsonUnsafe({ attemptID: "attempt-a", response: { type: "manual", code: "code" } }),
        ),
        HttpClientRequest.post(GlobalPaths.syncLogout),
        HttpClientRequest.get(GlobalPaths.syncSpaces),
        HttpClientRequest.post(GlobalPaths.syncSpaces).pipe(
          HttpClientRequest.bodyJsonUnsafe({ name: "Space A", encryption: "none" }),
        ),
        HttpClientRequest.post(GlobalPaths.syncSpaceJoin).pipe(
          HttpClientRequest.bodyJsonUnsafe({ namespaceID: descriptor.namespaceID }),
        ),
        HttpClientRequest.post(GlobalPaths.syncSpaceActivate).pipe(
          HttpClientRequest.bodyJsonUnsafe({ namespaceID: descriptor.namespaceID }),
        ),
        HttpClientRequest.post(GlobalPaths.syncSpaceLeave).pipe(
          HttpClientRequest.bodyJsonUnsafe({ namespaceID: descriptor.namespaceID }),
        ),
        HttpClientRequest.patch(GlobalPaths.syncEnabled).pipe(HttpClientRequest.bodyJsonUnsafe({ enabled: false })),
        HttpClientRequest.patch(GlobalPaths.syncInterval).pipe(
          HttpClientRequest.bodyJsonUnsafe({ intervalSeconds: 60 }),
        ),
        HttpClientRequest.delete(GlobalPaths.syncSpaceDelete.replace(":namespaceID", descriptor.namespaceID)),
        HttpClientRequest.delete(GlobalPaths.syncRemove),
        HttpClientRequest.get(GlobalPaths.syncUnassigned),
        HttpClientRequest.post(GlobalPaths.syncUnassigned).pipe(
          HttpClientRequest.bodyJsonUnsafe({ sessionIDs: ["session-unassigned"] }),
        ),
      ]
      const responses = yield* Effect.all(requests.map((request) => request.pipe(HttpClient.execute)))
      expect(responses.map((response) => response.status)).toEqual(Array.from({ length: requests.length }, () => 200))
    }),
  )

  it.live("does not expose the obsolete reuse-legacy or reset routes", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.all([
        HttpClientRequest.post("/global/sync/setup/reuse-legacy").pipe(HttpClient.execute),
        HttpClientRequest.post("/global/sync/reset").pipe(HttpClient.execute),
      ])
      expect(responses.map((response) => response.status)).toEqual([404, 404])
    }),
  )

  it.live("returns a typed pending-outbox switch result and an explicit unassigned snapshot", () =>
    Effect.gen(function* () {
      const blocked = yield* HttpClientRequest.post(GlobalPaths.syncSpaceActivate).pipe(
        HttpClientRequest.bodyJsonUnsafe({ namespaceID: "blocked" }),
        HttpClient.execute,
      )
      expect(blocked.status).toBe(200)
      expect(yield* blocked.json).toEqual({ status: "blocked", reason: "pending-outbox", outbox: 2 })

      const snapshot = yield* HttpClientRequest.get(GlobalPaths.syncUnassigned).pipe(HttpClient.execute)
      expect(snapshot.status).toBe(200)
      expect(yield* snapshot.json).toEqual(["session-unassigned"])

      const assigned = yield* HttpClientRequest.post(GlobalPaths.syncUnassigned).pipe(
        HttpClientRequest.bodyJsonUnsafe({ sessionIDs: ["session-unassigned"] }),
        HttpClient.execute,
      )
      expect(assigned.status).toBe(200)
      expect(yield* assigned.json).toEqual(["session-unassigned"])
    }),
  )

  it.live("reports redacted sync control status", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.syncStatus).pipe(HttpClient.execute)
      expect(response.status).toBe(200)
      expect(yield* response.json).toEqual({
        configured: false,
        initialized: false,
        authenticated: false,
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
