// Opencode publish boundary for core events. Attach routed instance location
// so direct EventV2 consumers can isolate directory/workspace streams.
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { GlobalBus } from "@/bus/global"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { Context, Effect, Layer, Option } from "effect"

export class Service extends Context.Service<Service, EventV2.Interface>()("@opencode/EventV2Bridge") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const sync = yield* SyncEventStore.Service

    const publishCaptured: EventV2.Interface["publish"] = (definition, data, options) =>
      events
        .publish(definition, data, options)
        .pipe(Effect.tap((event) => SessionSync.capture(sync, event as any).pipe(Effect.orDie)))

    const publish: EventV2.Interface["publish"] = (definition, data, options) =>
      Effect.gen(function* () {
        if (options?.location) return yield* publishCaptured(definition, data, options)
        const location = Option.getOrUndefined(yield* Effect.serviceOption(Location.Service))
        if (location)
          return yield* publishCaptured(definition, data, {
            ...options,
            location: new Location.Info({
              target: location.target,
              directory: location.directory,
              workspaceID: location.workspaceID,
              lastKnownTargetName: location.lastKnownTargetName,
              project: location.project,
            }),
          })
        const ctx = yield* InstanceRef
        if (!ctx) return yield* publishCaptured(definition, data, options)
        const workspaceID = yield* WorkspaceRef
        return yield* publishCaptured(definition, data, {
          ...options,
          location: new Location.Info({
            target: Location.LocalTarget.make({ type: "local" }),
            directory: AbsolutePath.make(ctx.directory),
            ...(workspaceID ? { workspaceID } : {}),
            project: { id: Project.ID.make(ctx.project.id), directory: AbsolutePath.make(ctx.worktree) },
          }),
        })
      })

    const unsubscribe = yield* events.listen((event) =>
      Effect.gen(function* () {
        const ctx = yield* InstanceRef
        const workspaceID = (yield* WorkspaceRef) ?? event.location?.workspaceID
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: { id: event.id, type: event.type, properties: event.data },
        })
        if (event.durable === undefined) return
        GlobalBus.emit("event", {
          directory: event.location?.directory ?? ctx?.directory,
          project: ctx?.project.id,
          workspace: workspaceID,
          payload: {
            type: "sync",
            syncEvent: {
              id: event.id,
              type: EventV2.versionedType(event.type, event.durable.version),
              seq: event.durable.seq,
              aggregateID: event.durable.aggregateID,
              data: event.data,
            },
          },
        })
      }),
    )
    yield* Effect.addFinalizer(() => unsubscribe)

    return Service.of({ ...events, publish })
  }),
)

export const node = LayerNode.make({ service: Service, layer: layer, deps: [EventV2.node, SyncEventStore.node] })

export * as EventV2Bridge from "./event-v2-bridge"
