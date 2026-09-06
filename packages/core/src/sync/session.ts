export * as SessionSync from "./session"

import { Cause, Effect, Layer, Stream } from "effect"
import { EventV2 } from "../event"
import { SyncEvent } from "./event"
import { SyncEventStore } from "./event-store"
import { Context } from "effect"
import { makeGlobalNode } from "../effect/app-node"

type DurablePayload = {
  readonly id: string
  readonly type: string
  readonly durable?: { readonly aggregateID: string; readonly seq: number }
  readonly data: Record<string, unknown>
}

/**
 * Captures the authoritative durable event stream. Deletion is translated to
 * a monotonic tombstone even while cloud sync is disabled; the Event store is
 * therefore the only source of global-delete truth.
 */
export function capture(store: SyncEventStore.Interface, payload: DurablePayload, createdAt = Date.now()) {
  if (!payload.durable) return Effect.void
  if (isSessionDeleted(payload))
    return store.delete(
      SyncEvent.Tombstone.make({ id: payload.id, sessionID: payload.durable.aggregateID, deletedAt: createdAt }),
      createdAt,
    )
  return store.enqueue(
    SyncEvent.Envelope.make({
      id: payload.id,
      aggregateID: payload.durable.aggregateID,
      seq: payload.durable.seq,
      type: payload.type,
      data: payload.data as Record<string, any>,
    }),
    createdAt,
  )
}

/** Adapter used by SyncRuntime hydration to replay through normal projectors. */
export function projector(events: EventV2.Interface, sourceDeviceID?: SyncEvent.DeviceID): SyncEvent.DurableProjector {
  const siblings = new Map<string, string>()
  return {
    project: (event) =>
      Effect.gen(function* () {
        const existing = siblings.get(event.aggregateID)
        if (existing) return yield* replayAs(events, event, existing, sourceDeviceID)
        const replay = events.replay(serialized(event), {
          publish: true,
          ...(sourceDeviceID ? { ownerID: sourceDeviceID, strictOwner: true } : {}),
        })
        const exit = yield* Effect.exit(replay)
        if (exit._tag === "Success") return
        const failure = Cause.squash(exit.cause)
        if (
          !sourceDeviceID ||
          !(failure instanceof EventV2.InvalidDurableEventError) ||
          !["Replay diverged", "Replay owner mismatch"].some((message) => failure.message.includes(message))
        )
          return yield* Effect.failCause(exit.cause)
        const sibling = yield* Effect.promise(() => siblingID(event.aggregateID, sourceDeviceID))
        siblings.set(event.aggregateID, sibling)
        const prefix = yield* events.durable({ aggregateID: event.aggregateID }).pipe(
          Stream.takeWhile((item) => (item.durable?.seq ?? Number.MAX_SAFE_INTEGER) < event.seq),
          Stream.runCollect,
        )
        for (const item of prefix) {
          if (!item.durable) continue
          yield* events.replay(
            {
              id: EventV2.ID.create(),
              aggregateID: sibling,
              seq: item.durable.seq,
              type: item.type,
              data: replaceSessionID(item.data as Record<string, unknown>, event.aggregateID, sibling),
            },
            { publish: true, ownerID: sourceDeviceID, strictOwner: true },
          )
        }
        yield* replayAs(events, event, sibling, sourceDeviceID)
      }),
    delete: (tombstone) => events.remove(tombstone.sessionID),
  }
}

function serialized(event: SyncEvent.Envelope): EventV2.SerializedEvent {
  return {
    id: EventV2.ID.make(event.id),
    aggregateID: event.aggregateID,
    seq: event.seq,
    type: event.type,
    data: event.data,
  }
}

function replayAs(
  events: EventV2.Interface,
  event: SyncEvent.Envelope,
  sessionID: string,
  ownerID?: SyncEvent.DeviceID,
) {
  return events.replay(
    {
      ...serialized(event),
      id: EventV2.ID.create(),
      aggregateID: sessionID,
      data: replaceSessionID(event.data, event.aggregateID, sessionID),
    },
    { publish: true, ...(ownerID ? { ownerID, strictOwner: true } : {}) },
  )
}

function replaceSessionID(value: unknown, source: string, target: string): any {
  if (Array.isArray(value)) return value.map((item) => replaceSessionID(item, source, target))
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      (key === "sessionID" || key === "id") && item === source ? target : replaceSessionID(item, source, target),
    ]),
  )
}

async function siblingID(sessionID: string, deviceID: string) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`opencode-sync-sibling\0${sessionID}\0${deviceID}`),
  )
  return `${sessionID}-conflict-${Buffer.from(bytes).toString("hex").slice(0, 16)}`
}

/** Scoped bridge used by the application runtime after sync.db is available. */
export const captureLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SyncEventStore.Service
    yield* events.all().pipe(
      Stream.runForEach((event) => capture(store, event as DurablePayload)),
      Effect.forkScoped,
    )
  }),
)

export class Capture extends Context.Service<Capture, true>()("@opencode/SessionSyncCapture") {}
const captureServiceLayer = Layer.provideMerge(Layer.succeed(Capture, true), captureLayer)
export const node = makeGlobalNode({
  service: Capture,
  layer: captureServiceLayer,
  deps: [EventV2.node, SyncEventStore.node],
})

function isSessionDeleted(payload: DurablePayload) {
  return payload.type === "session.deleted" || payload.type.startsWith("session.deleted@")
}
