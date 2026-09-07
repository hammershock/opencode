export * as SessionSync from "./session"

import { Cause, Effect, Layer, Stream } from "effect"
import { EventV2 } from "../event"
import { SyncAttachment } from "./attachment"
import { SyncEvent } from "./event"
import { SyncEventStore } from "./event-store"
import { Context } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SyncOwnership } from "./ownership"
import { Database } from "../database/database"
import { SessionTable } from "../session/sql"
import { isNotNull } from "drizzle-orm"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"

type DurablePayload = {
  readonly id: string
  readonly type: string
  readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
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
      type: EventV2.versionedType(payload.type, payload.durable.version),
      // Runtime domain objects may retain optional keys with `undefined` even
      // though the durable wire format is JSON. Normalize at the sync boundary
      // so capture matches the bytes other devices can actually replay.
      data: JSON.parse(JSON.stringify(payload.data)) as Record<string, any>,
    }),
    createdAt,
  )
}

/** Resolves durable Session ownership before selecting a space-scoped outbox. */
export function captureOwned(
  ownership: Pick<SyncOwnership.Interface, "assign" | "get">,
  store: SyncEventStore.Interface,
  payload: DurablePayload,
  createdAt = Date.now(),
) {
  return Effect.gen(function* () {
    if (!payload.durable) return
    const createdSpaceID = sessionCreatedSpace(payload)
    if (createdSpaceID) yield* ownership.assign(payload.durable.aggregateID, createdSpaceID, createdAt)
    const owned = createdSpaceID ? { spaceID: createdSpaceID } : yield* ownership.get(payload.durable.aggregateID)
    if (!owned) return
    yield* capture(store.scope(owned.spaceID), payload, createdAt)
  })
}

/** Converts an event to the compact attachment-aware wire representation. */
export async function externalize(
  event: SyncEvent.Envelope,
  attachment: Pick<SyncAttachment.Interface, "put">,
): Promise<SyncEvent.Envelope> {
  return SyncEvent.Envelope.make({
    ...event,
    data: (await SyncAttachment.externalize(event.data, attachment)) as Record<string, any>,
  })
}

/** Restores attachment references before an event reaches the Session projector. */
export async function hydrate(
  event: SyncEvent.Envelope,
  attachment: Pick<SyncAttachment.Interface, "get">,
): Promise<SyncEvent.Envelope> {
  return SyncEvent.Envelope.make({
    ...event,
    data: (await SyncAttachment.hydrate(event.data, attachment)) as Record<string, any>,
  })
}

/** Adapter used by SyncRuntime hydration to replay through normal projectors. */
export function projector(
  events: EventV2.Interface,
  sourceDeviceID?: SyncEvent.DeviceID,
  onConflict?: (input: {
    sessionID: string
    siblingID: string
    sourceDeviceID: SyncEvent.DeviceID
  }) => Effect.Effect<void, unknown>,
  attachment?: Pick<SyncAttachment.Interface, "get">,
  onDelete?: (sessionID: string) => Effect.Effect<void, unknown>,
  spaceID?: string,
  onOwned?: (sessionID: string, spaceID: string) => Effect.Effect<void, unknown>,
): SyncEvent.DurableProjector {
  const siblings = new Map<string, string>()
  return {
    project: (event) =>
      Effect.gen(function* () {
        const restored = attachment ? yield* Effect.tryPromise(() => hydrate(event, attachment)) : event
        const hydrated = spaceID ? bindCreatedSpace(restored, spaceID) : restored
        const existing = siblings.get(hydrated.aggregateID)
        if (existing) return yield* replayAs(events, hydrated, existing, sourceDeviceID)
        const replay = events.replay(serialized(hydrated), {
          publish: true,
          ...(sourceDeviceID ? { ownerID: sourceDeviceID, strictOwner: true } : {}),
        })
        const exit = yield* Effect.exit(replay)
        if (exit._tag === "Success") {
          if (spaceID && onOwned && isCreatedEnvelope(hydrated))
            yield* onOwned(hydrated.aggregateID, spaceID).pipe(Effect.orDie)
          return
        }
        const failure = Cause.squash(exit.cause)
        if (
          !sourceDeviceID ||
          !(failure instanceof EventV2.InvalidDurableEventError) ||
          !["Replay diverged", "Replay owner mismatch"].some((message) => failure.message.includes(message))
        )
          return yield* Effect.failCause(exit.cause)
        const sibling = yield* Effect.promise(() => siblingID(hydrated.aggregateID, sourceDeviceID, hydrated.seq))
        siblings.set(hydrated.aggregateID, sibling)
        if (spaceID && onOwned) yield* onOwned(sibling, spaceID).pipe(Effect.orDie)
        if (onConflict)
          yield* onConflict({ sessionID: hydrated.aggregateID, siblingID: sibling, sourceDeviceID }).pipe(Effect.orDie)
        const prefix = yield* events.durable({ aggregateID: hydrated.aggregateID }).pipe(
          // Durable aggregate sequences are contiguous and zero based. Taking
          // exactly `seq` items snapshots the common prefix without subscribing
          // forever to the live tail.
          Stream.take(hydrated.seq),
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
              data: replaceSessionID(item.data as Record<string, unknown>, hydrated.aggregateID, sibling),
            },
            { publish: true, ownerID: sourceDeviceID, strictOwner: true },
          )
        }
        yield* replayAs(events, hydrated, sibling, sourceDeviceID)
      }),
    delete: (tombstone) =>
      Effect.gen(function* () {
        if (onDelete) yield* onDelete(tombstone.sessionID)
        yield* events.remove(tombstone.sessionID)
      }),
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

function isCreatedEnvelope(event: SyncEvent.Envelope) {
  return event.type === "session.created" || event.type.startsWith("session.created@")
}

function bindCreatedSpace(event: SyncEvent.Envelope, spaceID: string) {
  if (!isCreatedEnvelope(event)) return event
  const info = event.data.info
  if (!info || typeof info !== "object") return event
  return SyncEvent.Envelope.make({
    ...event,
    data: { ...event.data, info: { ...(info as Record<string, unknown>), syncSpaceID: spaceID } },
  })
}

async function siblingID(sessionID: string, deviceID: string, firstConflictSeq: number) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`opencode-sync-sibling\0${sessionID}\0${deviceID}\0${firstConflictSeq}`),
  )
  return `${sessionID}-conflict-${Buffer.from(bytes).toString("hex").slice(0, 16)}`
}

/** Scoped bridge used by the application runtime after sync.db is available. */
export const captureLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const events = yield* EventV2.Service
    const store = yield* SyncEventStore.Service
    const ownership = yield* SyncOwnership.Service
    const db = (yield* Database.Service).db
    const existing = yield* db
      .select({
        sessionID: SessionTable.id,
        spaceID: SessionTable.sync_space_id,
        assignedAt: SessionTable.time_created,
      })
      .from(SessionTable)
      .where(isNotNull(SessionTable.sync_space_id))
      .all()
    yield* Effect.forEach(existing, (item) => ownership.assign(item.sessionID, item.spaceID!, item.assignedAt), {
      discard: true,
    })
    yield* events.all().pipe(
      Stream.runForEach((event) => captureOwned(ownership, store, event as DurablePayload)),
      Effect.forkScoped,
    )
    // Session and sync outbox use separate SQLite databases. Replaying the
    // owned durable history after the live subscriber starts closes the crash
    // window between a committed Session event and its asynchronous capture.
    // Enqueue is idempotent by event ID, so overlap with the live stream is safe.
    yield* Effect.forEach(
      yield* ownership.list(),
      (item) =>
        Effect.gen(function* () {
          let after = -1
          while (true) {
            const page = yield* EventV2.readAggregate(db, {
              aggregateID: item.sessionID,
              after,
              limit: 256,
              manifest: SessionDurable,
            })
            yield* Effect.forEach(page.events, (event) => capture(store.scope(item.spaceID), event as DurablePayload), {
              discard: true,
            })
            const last = page.events.at(-1)
            if (!page.hasMore || !last?.durable) break
            after = last.durable.seq
          }
        }),
      { discard: true },
    )
  }),
)

export class Capture extends Context.Service<Capture, true>()("@opencode/SessionSyncCapture") {}
const captureServiceLayer = Layer.provideMerge(Layer.succeed(Capture, true), captureLayer)
export const node = makeGlobalNode({
  service: Capture,
  layer: captureServiceLayer,
  deps: [EventV2.node, SyncEventStore.node, SyncOwnership.node, Database.node],
})

function isSessionDeleted(payload: DurablePayload) {
  return payload.type === "session.deleted" || payload.type.startsWith("session.deleted@")
}

function sessionCreatedSpace(payload: DurablePayload) {
  if (payload.type !== "session.created" && !payload.type.startsWith("session.created@")) return
  const info = payload.data.info
  if (!info || typeof info !== "object") return
  const value = (info as Record<string, unknown>).syncSpaceID
  return typeof value === "string" && value ? value : undefined
}
