import { Config } from "@/config/config"
import { GlobalBus, type GlobalEvent as GlobalBusEvent } from "@/bus/global"
import { EffectBridge } from "@/effect/bridge"
import { EventV2 } from "@opencode-ai/core/event"
import { Installation } from "@/installation"
import { disposeAllInstancesAndEmitGlobalDisposed } from "@/server/global-lifecycle"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Queue } from "effect"
import * as Stream from "effect/Stream"
import { HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Sse from "effect/unstable/encoding/Sse"
import { RootHttpApi } from "../api"
import {
  GlobalUpgradeInput,
  SyncIncompatibleLocalStateMessage,
  SyncMissingAppMessage,
  SyncSetupApiError,
  SyncControlApiError,
} from "../groups/global"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { HttpApiError } from "effect/unstable/httpapi"
import { SyncControl } from "@opencode-ai/core/sync/control"

function eventData(data: unknown): Sse.Event {
  return {
    _tag: "Event",
    event: "message",
    id: undefined,
    data: JSON.stringify(data),
  }
}

function eventResponse() {
  return Effect.gen(function* () {
    yield* Effect.logInfo("global event connected")
    const events = Stream.callback<GlobalBusEvent>((queue) => {
      const handler = (event: GlobalBusEvent) => Queue.offerUnsafe(queue, event)
      return Effect.acquireRelease(
        Effect.sync(() => GlobalBus.on("event", handler)),
        () => Effect.sync(() => GlobalBus.off("event", handler)),
      )
    })
    const heartbeat = Stream.tick("10 seconds").pipe(
      Stream.drop(1),
      Stream.map(() => ({ payload: { id: EventV2.ID.create(), type: "server.heartbeat", properties: {} } })),
    )

    return HttpServerResponse.stream(
      Stream.make({ payload: { id: EventV2.ID.create(), type: "server.connected", properties: {} } }).pipe(
        Stream.concat(events.pipe(Stream.merge(heartbeat, { haltStrategy: "left" }))),
        Stream.map(eventData),
        Stream.pipeThroughChannel(Sse.encode()),
        Stream.encodeText,
        Stream.ensuring(Effect.logInfo("global event disconnected")),
      ),
      {
        contentType: "text/event-stream",
        headers: {
          "Cache-Control": "no-cache, no-transform",
          "X-Accel-Buffering": "no",
          "X-Content-Type-Options": "nosniff",
        },
      },
    )
  })
}

export const globalHandlers = HttpApiBuilder.group(RootHttpApi, "global", (handlers) =>
  Effect.gen(function* () {
    const config = yield* Config.Service
    const installation = yield* Installation.Service
    const bridge = yield* EffectBridge.make()
    const syncSetup = yield* SyncSetup.Service
    const syncControl = yield* SyncControl.Service

    const health = Effect.fn("GlobalHttpApi.health")(function* () {
      return { healthy: true as const, version: InstallationVersion }
    })

    const event = Effect.fn("GlobalHttpApi.event")(function* () {
      return yield* eventResponse()
    })

    const configGet = Effect.fn("GlobalHttpApi.configGet")(function* () {
      return yield* config.getGlobal()
    })

    const configUpdate = Effect.fn("GlobalHttpApi.configUpdate")(function* (ctx) {
      const result = yield* config.updateGlobal(ctx.payload)
      if (result.changed) bridge.fork(disposeAllInstancesAndEmitGlobalDisposed({ swallowErrors: true }))
      return result.info
    })

    const dispose = Effect.fn("GlobalHttpApi.dispose")(function* () {
      yield* disposeAllInstancesAndEmitGlobalDisposed()
      return true
    })

    const badSetup = <A>(effect: Effect.Effect<A, SyncSetup.SetupError>) =>
      effect.pipe(
        Effect.mapError((error) => {
          if (error.kind === "missing-app")
            return new SyncSetupApiError({
              name: "SyncSetupError",
              data: { kind: "missing-app", message: SyncMissingAppMessage },
            })
          if (error.kind === "incompatible-local-state")
            return new SyncSetupApiError({
              name: "SyncSetupError",
              data: { kind: "incompatible-local-state", message: SyncIncompatibleLocalStateMessage },
            })
          return new SyncSetupApiError({
            name: "SyncSetupError",
            data: { kind: "bad-request", message: "Sync setup request failed" },
          })
        }),
      )
    const badControl = <A>(effect: Effect.Effect<A, SyncControl.ControlError>) =>
      effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))
    const stateAfter = (effect: Effect.Effect<void, SyncControl.ControlError>) =>
      effect.pipe(
        Effect.andThen(syncSetup.state()),
        Effect.flatMap((state) => (state ? Effect.succeed(state) : Effect.fail(new HttpApiError.BadRequest({})))),
        Effect.mapError(() => new HttpApiError.BadRequest({})),
      )

    const getSyncState = Effect.fn("GlobalHttpApi.syncState")(() =>
      badSetup(syncSetup.state()).pipe(Effect.map((state) => state ?? null)),
    )

    const upgrade = Effect.fn("GlobalHttpApi.upgrade")(function* (ctx: { payload: typeof GlobalUpgradeInput.Type }) {
      const method = yield* installation.method()
      if (method === "unknown") {
        return HttpServerResponse.jsonUnsafe(
          { success: false as const, error: "Unknown installation method" },
          { status: 400 },
        )
      }
      const target = ctx.payload.target
      const result = yield* installation.upgrade(method, target).pipe(
        Effect.as({ success: true as const, version: target }),
        Effect.catch((err) =>
          Effect.succeed({
            success: false as const,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      )
      if (!result.success) return HttpServerResponse.jsonUnsafe(result, { status: 500 })
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: Installation.Event.Updated.type,
          properties: { version: target },
        },
      })
      return HttpServerResponse.jsonUnsafe(result)
    })

    return handlers
      .handle("health", health)
      .handleRaw("event", event)
      .handle("configGet", configGet)
      .handle("configUpdate", configUpdate)
      .handle("syncState", getSyncState)
      .handle("syncInitialize", (ctx) => badSetup(syncSetup.initialize(ctx.payload.deviceName)))
      .handle("syncOAuthBegin", (ctx) => badSetup(syncSetup.begin(ctx.payload)))
      .handle("syncOAuthComplete", (ctx) => badSetup(syncSetup.complete(ctx.payload)))
      .handle("syncOAuthSwitchAccount", (ctx) => badControl(syncControl.switchAccount(ctx.payload)))
      .handle("syncLogout", () => stateAfter(syncControl.logout()))
      .handle("syncDiscover", () =>
        syncSetup.discover().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncCreate", (ctx) => badSetup(syncSetup.create(ctx.payload)))
      .handle("syncJoin", (ctx) => badSetup(syncControl.join(ctx.payload)))
      .handle("syncActivate", (ctx) => badControl(syncControl.switchSpace(ctx.payload)))
      .handle("syncLeave", (ctx) => badControl(syncControl.leaveSpace(ctx.payload.namespaceID)))
      .handle("syncEnabled", (ctx) => stateAfter(syncControl.enable(ctx.payload.enabled)))
      .handle("syncInterval", (ctx) => stateAfter(syncControl.setInterval(ctx.payload.intervalSeconds)))
      .handle("syncDelete", (ctx) => badControl(syncControl.deleteSpace(ctx.params.namespaceID)))
      .handle("syncRemove", () => badControl(syncControl.removeFromDevice()))
      .handle("syncUnassigned", () =>
        syncControl.unassigned().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncAssignUnassigned", (ctx) => badControl(syncControl.assignUnassigned(ctx.payload)))
      .handle("syncStatus", () =>
        syncControl.status().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncNow", () =>
        syncControl.now().pipe(
          Effect.as(true),
          Effect.mapError((error) =>
            new SyncControlApiError({
              name: "SyncControlError",
              data: { kind: error.kind, diagnostic: error.diagnostic },
            }),
          ),
        ),
      )
      .handle("syncSessions", () =>
        syncControl.sessions().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncHydrate", (ctx) =>
        syncControl.hydrate(ctx.payload).pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncDevices", () =>
        syncControl.devices().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncDeviceUpdate", (ctx) =>
        syncControl.updateDevice(ctx.payload).pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      .handle("syncRecoveryExport", () =>
        syncControl.exportKey().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
