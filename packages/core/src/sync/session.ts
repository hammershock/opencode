export * as SessionSync from "./session"

import { Effect, Layer, Stream } from "effect"
import { EventV2 } from "../event"
import { SyncEvent } from "./event"
import { SyncEventStore } from "./event-store"

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
export function projector(events: EventV2.Interface): SyncEvent.Projector<SyncEventStore.Transaction> {
  return {
    project: (_transaction, event) =>
      events.replay(
        {
          id: EventV2.ID.make(event.id),
          aggregateID: event.aggregateID,
          seq: event.seq,
          type: event.type,
          data: event.data,
        },
        { publish: true },
      ),
    delete: (_transaction, tombstone) => events.remove(tombstone.sessionID),
  }
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

function isSessionDeleted(payload: DurablePayload) {
  return payload.type === "session.deleted" || payload.type.startsWith("session.deleted@")
}
