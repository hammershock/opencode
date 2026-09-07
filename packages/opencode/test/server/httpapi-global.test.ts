import { NodeHttpServer } from "@effect/platform-node"
import { describe, expect } from "bun:test"
import { Context, Effect, Fiber, Layer, Option, Scope } from "effect"
import { HttpBody, HttpClient, HttpClientRequest, HttpRouter } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Installation } from "../../src/installation"
import { MoveSession } from "@opencode-ai/core/control-plane/move-session"
import { ServerAuth } from "../../src/server/auth"
import { RootHttpApi } from "../../src/server/routes/instance/httpapi/api"
import {
  GlobalPaths,
  SyncIncompatibleLocalStateMessage,
  SyncMissingAppMessage,
} from "../../src/server/routes/instance/httpapi/groups/global"
import { controlHandlers } from "../../src/server/routes/instance/httpapi/handlers/control"
import { controlPlaneHandlers } from "../../src/server/routes/instance/httpapi/handlers/control-plane"
import { globalHandlers } from "../../src/server/routes/instance/httpapi/handlers/global"
import { authorizationLayer } from "../../src/server/routes/instance/httpapi/middleware/authorization"
import { schemaErrorLayer } from "../../src/server/routes/instance/httpapi/middleware/schema-error"
import { pollWithTimeout, testEffect } from "../lib/effect"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncMetadata } from "@opencode-ai/core/sync/metadata"
import { SyncState } from "@opencode-ai/core/sync/state"
import { SyncSpace } from "@opencode-ai/core/sync/space"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"

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

const makeApiLayer = (
  state: SyncSetup.Interface["state"] = () => Effect.succeed(syncState),
  now: SyncControl.Interface["now"] = () => Effect.void,
  deleteSpace: SyncControl.Interface["deleteSpace"] = () => Effect.succeed(["session-a"]),
) =>
  HttpRouter.serve(
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
        state,
        initialize: () => Effect.succeed(syncState),
        begin: (input) =>
          input.redirectURI.endsWith("/missing-app")
            ? Effect.fail(new SyncSetup.SetupError({ kind: "missing-app" }))
            : input.redirectURI.endsWith("/incompatible-local-state")
              ? Effect.fail(new SyncSetup.SetupError({ kind: "incompatible-local-state" }))
              : input.redirectURI.endsWith("/internal-storage-failure")
                ? Effect.fail(new SyncSetup.SetupError({ kind: "storage" }))
                : Effect.succeed({
                    attemptID: "attempt-a",
                    authorizationURL: input.redirectURI,
                    completion: input.completion,
                  }),
        complete: () => Effect.succeed(syncState),
        switchAccount: () => Effect.succeed(syncState),
        logout: () => Effect.succeed(syncState),
        discover: () => Effect.succeed({ spaces: [{ status: "compatible", descriptor }], deletions: [] }),
        create: () => Effect.succeed({ state: syncState, descriptor }),
        join: () => Effect.die("Sync join must be orchestrated by SyncControl"),
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
        join: () => Effect.succeed(syncState),
        now,
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
        deleteSpace,
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
const apiLayer = makeApiLayer()
const it = testEffect(apiLayer)
const incompatibleStateIt = testEffect(
  makeApiLayer(() => Effect.fail(new SyncSetup.SetupError({ kind: "incompatible-local-state" }))),
)
const failedSyncIt = testEffect(
  makeApiLayer(undefined, () =>
    Effect.fail(
      new SyncControl.ControlError({
        kind: "provider",
        diagnostic: {
          stage: "segment",
          operation: "upload",
          kind: "network",
          retryable: true,
          outcome: "unknown",
          message: "Sync segment failed",
        },
      }),
    ),
  ),
)
const failedDeleteIt = testEffect(
  makeApiLayer(undefined, undefined, () =>
    Effect.fail(
      new SyncControl.ControlError({
        kind: "provider",
        diagnostic: {
          stage: "delete",
          operation: "delete",
          kind: "network",
          retryable: true,
          outcome: "failed",
          message: "Sync delete failed",
        },
      }),
    ),
  ),
)
let syncStarted = false
let resumeSync = () => {}
const hangingSyncIt = testEffect(
  makeApiLayer(undefined, () =>
    Effect.promise(
      () =>
        new Promise<void>((resolve) => {
          syncStarted = true
          resumeSync = resolve
        }),
    ),
  ),
)

describe("global HttpApi", () => {
  hangingSyncIt.live("serves local status while Sync Now is waiting and recovers afterward", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.Scope
      const sync = yield* HttpClientRequest.post(GlobalPaths.syncNow).pipe(HttpClient.execute, Effect.forkIn(scope))
      yield* pollWithTimeout(
        Effect.sync(() => (syncStarted ? true : undefined)),
        "Sync Now request did not start",
      )

      const status = yield* HttpClientRequest.get(GlobalPaths.syncStatus).pipe(
        HttpClient.execute,
        Effect.timeout("250 millis"),
      )
      expect(status.status).toBe(200)

      resumeSync()
      expect((yield* Fiber.join(sync)).status).toBe(200)
      expect((yield* HttpClientRequest.get(GlobalPaths.syncStatus).pipe(HttpClient.execute)).status).toBe(200)
    }),
  )

  failedSyncIt.live("returns a redacted structured Sync Now diagnostic", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(GlobalPaths.syncNow).pipe(HttpClient.execute)
      expect(response.status).toBe(503)
      expect(yield* response.json).toEqual({
        name: "SyncControlError",
        data: {
          kind: "provider",
          diagnostic: {
            stage: "segment",
            operation: "upload",
            kind: "network",
            retryable: true,
            outcome: "unknown",
            message: "Sync segment failed",
          },
        },
      })
    }),
  )

  failedDeleteIt.live("returns a redacted structured space deletion diagnostic", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.delete(
        GlobalPaths.syncSpaceDelete.replace(":namespaceID", "space-a"),
      ).pipe(HttpClient.execute)
      expect(response.status).toBe(503)
      expect(yield* response.json).toEqual({
        name: "SyncControlError",
        data: {
          kind: "provider",
          diagnostic: {
            stage: "delete",
            operation: "delete",
            kind: "network",
            retryable: true,
            outcome: "failed",
            message: "Sync delete failed",
          },
        },
      })
    }),
  )

  incompatibleStateIt.live("returns the typed incompatible reason from sync state", () =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.get(GlobalPaths.syncState).pipe(HttpClient.execute)
      expect(response.status).toBe(400)
      expect(yield* response.json).toEqual({
        name: "SyncSetupError",
        data: { kind: "incompatible-local-state", message: SyncIncompatibleLocalStateMessage },
      })
    }),
  )

  it.live("preserves the redacted missing-app code through the generated SDK boundary", () =>
    Effect.gen(function* () {
      const raw = yield* HttpClientRequest.post(GlobalPaths.syncOAuthBegin).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          redirectURI: "http://127.0.0.1/missing-app",
          completion: "loopback",
        }),
        HttpClient.execute,
      )
      expect(raw.status).toBe(400)
      const body = yield* raw.json
      expect(body).toEqual({
        name: "SyncSetupError",
        data: { kind: "missing-app", message: SyncMissingAppMessage },
      })
      const sdk = createOpencodeClient({
        baseUrl: "http://localhost",
        // Feed the exact body emitted by the in-process handler through the
        // generated client's real decoding and error interceptor.
        fetch: (async () =>
          new Response(JSON.stringify(body), {
            status: raw.status,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      })
      const caught = yield* Effect.promise(async () => {
        try {
          await sdk.global.syncOAuthBegin(
            { redirectURI: "http://127.0.0.1/missing-app", completion: "loopback" },
            { throwOnError: true },
          )
        } catch (error) {
          return error
        }
      })
      expect(caught).toBeInstanceOf(Error)
      const error = caught as Error
      const cause = error.cause as { status?: number; body?: unknown }
      expect(error.message).toBe(SyncMissingAppMessage)
      expect(cause.status).toBe(400)
      expect(cause.body).toEqual({
        name: "SyncSetupError",
        data: { kind: "missing-app", message: SyncMissingAppMessage },
      })
      expect(JSON.stringify(cause.body)).not.toContain("secret")

      const incompatible = yield* HttpClientRequest.post(GlobalPaths.syncOAuthBegin).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          redirectURI: "http://127.0.0.1/incompatible-local-state",
          completion: "loopback",
        }),
        HttpClient.execute,
      )
      expect(incompatible.status).toBe(400)
      expect(yield* incompatible.json).toEqual({
        name: "SyncSetupError",
        data: { kind: "incompatible-local-state", message: SyncIncompatibleLocalStateMessage },
      })

      const generic = yield* HttpClientRequest.post(GlobalPaths.syncOAuthBegin).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          redirectURI: "http://127.0.0.1/internal-storage-failure",
          completion: "loopback",
        }),
        HttpClient.execute,
      )
      expect(generic.status).toBe(400)
      expect(yield* generic.json).toEqual({
        name: "SyncSetupError",
        data: { kind: "bad-request", message: "Sync setup request failed" },
      })
    }),
  )

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

  it.live("does not expose obsolete setup or duplicate target-binding routes", () =>
    Effect.gen(function* () {
      const responses = yield* Effect.all([
        HttpClientRequest.post("/global/sync/setup/reuse-legacy").pipe(HttpClient.execute),
        HttpClientRequest.post("/global/sync/reset").pipe(HttpClient.execute),
        HttpClientRequest.patch("/global/sync/bindings").pipe(
          HttpClientRequest.bodyJsonUnsafe({ label: "lab", targetID: "device-local-target" }),
          HttpClient.execute,
        ),
      ])
      expect(responses.map((response) => response.status)).toEqual([404, 404, 404])
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
