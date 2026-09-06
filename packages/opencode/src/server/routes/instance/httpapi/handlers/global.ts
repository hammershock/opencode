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
import { GlobalUpgradeInput } from "../groups/global"
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
      effect.pipe(Effect.mapError(() => new HttpApiError.BadRequest({})))

    const getSyncSetup = Effect.fn("GlobalHttpApi.syncSetup")(function* () {
      const [current, legacy] = yield* Effect.all([syncSetup.config(), syncSetup.inspectLegacy()]).pipe(
        Effect.mapError(() => new HttpApiError.ServiceUnavailable({})),
      )
      return { config: current, legacy }
    })

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
      .handle("syncSetup", getSyncSetup)
      .handle("syncAuthorize", (ctx) => badSetup(syncSetup.begin(ctx.payload)))
      .handle("syncComplete", (ctx) => badSetup(syncSetup.complete(ctx.payload)))
      .handle("syncReuseLegacy", (ctx) => badSetup(syncSetup.reuseLegacy(ctx.payload)))
      .handle("syncEnabled", (ctx) =>
        syncControl.enable(ctx.payload.enabled).pipe(
          Effect.andThen(syncSetup.config()),
          Effect.flatMap((config) => (config ? Effect.succeed(config) : Effect.fail(new HttpApiError.BadRequest({})))),
          Effect.mapError(() => new HttpApiError.BadRequest({})),
        ),
      )
      .handle("syncStatus", () =>
        syncControl.status().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncNow", () =>
        syncControl.now().pipe(
          Effect.as(true),
          Effect.mapError(() => new HttpApiError.ServiceUnavailable({})),
        ),
      )
      .handle("syncDevices", () =>
        syncControl.devices().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("syncDeviceUpdate", (ctx) =>
        syncControl.updateDevice(ctx.payload).pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      .handle("syncBindingUpdate", (ctx) =>
        syncControl.updateBinding(ctx.payload).pipe(Effect.mapError(() => new HttpApiError.BadRequest({}))),
      )
      .handle("syncRecoveryExport", () =>
        syncControl.exportKey().pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable({}))),
      )
      .handle("dispose", dispose)
      .handle("upgrade", upgrade)
  }),
)
