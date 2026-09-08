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
import { SessionV2 } from "../session"
import { SessionActivity } from "../session/activity"
import { SessionLocationMutation } from "../session/location-mutation"
import { eq } from "drizzle-orm"
import { SessionSyncDurable } from "@opencode-ai/schema/durable-event-manifest"
import { SessionV1 } from "@opencode-ai/schema/session-v1"

type DurablePayload = {
  readonly id: string
  readonly type: string
  readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
  readonly data: Record<string, unknown>
}

export type PersistedOwnership = { readonly exists: true; readonly spaceID?: string } | { readonly exists: false }
export type PersistedMembership = { readonly sessionID: string; readonly spaceID?: string; readonly assignedAt: number }

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
      data: normalizeCapturedData(payload.type, payload.data),
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
  persisted?: (sessionID: string) => Effect.Effect<PersistedOwnership, unknown>,
) {
  return Effect.gen(function* () {
    if (!payload.durable) return
    const createdSpaceID = sessionCreatedSpace(payload)
    if (createdSpaceID) yield* ownership.assign(payload.durable.aggregateID, createdSpaceID, createdAt)
    const current = createdSpaceID || !persisted ? undefined : yield* persisted(payload.durable.aggregateID)
    // A surviving Session row is the canonical live membership record. In
    // particular, an explicit NULL must override a stale cross-database
    // ownership row left behind by a crash during Leave/Remove.
    if (current?.exists && !current.spaceID) return
    if (current?.exists && current.spaceID)
      yield* ownership.assign(payload.durable.aggregateID, current.spaceID, createdAt)
    // Once a deleted Session row is gone, durable ownership remains necessary
    // to route its final deletion event/tombstone to the original space.
    const owned = createdSpaceID
      ? { spaceID: createdSpaceID }
      : current?.exists
        ? { spaceID: current.spaceID! }
        : yield* ownership.get(payload.durable.aggregateID)
    if (!owned) return
    yield* capture(store.scope(owned.spaceID), payload, createdAt)
  })
}

/** Idempotently copies a Session's committed durable history into one space outbox. */
export function backfill(
  db: Database.Interface["db"],
  store: SyncEventStore.Interface,
  sessionID: string,
  spaceID: string,
) {
  return Effect.gen(function* () {
    let after = -1
    while (true) {
      const page = yield* EventV2.readAggregate(db, {
        aggregateID: sessionID,
        after,
        limit: 256,
        manifest: SessionSyncDurable,
      })
      yield* Effect.forEach(page.events, (event) => capture(store.scope(spaceID), event as DurablePayload), {
        discard: true,
      })
      const last = page.events.at(-1)
      if (!page.hasMore || !last?.durable) break
      after = last.durable.seq
    }
  })
}

/** Repairs the cross-database ownership index from every surviving Session row. */
export function reconcileOwnership(
  ownership: Pick<SyncOwnership.Interface, "assign" | "unassign">,
  rows: readonly PersistedMembership[],
) {
  return Effect.forEach(
    rows,
    (row) =>
      row.spaceID ? ownership.assign(row.sessionID, row.spaceID, row.assignedAt) : ownership.unassign(row.sessionID),
    { discard: true },
  )
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
  activity?: SessionActivity.Interface,
  locationMutation?: SessionLocationMutation.Interface,
): SyncEvent.DurableProjector {
  const siblings = new Map<string, string>()
  return {
    project: (event) => {
      const replay = Effect.gen(function* () {
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
            { publish: true, ownerID: sourceDeviceID, strictOwner: true, allowEquivalent: true },
          )
        }
        yield* replayAs(events, hydrated, sibling, sourceDeviceID)
      })
      const tracked = activity
        ? activity.withActivity(SessionV2.ID.make(event.aggregateID), "sync_replay", replay)
        : replay
      return locationMutation ? locationMutation.withLock(tracked) : tracked
    },
    delete: (tombstone) => {
      const remove = Effect.gen(function* () {
        if (onDelete) yield* onDelete(tombstone.sessionID)
        yield* events.remove(tombstone.sessionID)
      })
      const tracked = activity
        ? activity.withActivity(SessionV2.ID.make(tombstone.sessionID), "sync_replay", remove)
        : remove
      return locationMutation ? locationMutation.withLock(tracked) : tracked
    },
  }
}

function serialized(event: SyncEvent.Envelope): EventV2.SerializedEvent {
  return {
    id: EventV2.ID.make(event.id),
    aggregateID: event.aggregateID,
    seq: event.seq,
    type: event.type,
    data: normalizeLegacyWireData(event),
  }
}

function normalizeLegacyWireData(event: SyncEvent.Envelope) {
  // Early sync builds JSON-stringified DateTime values instead of applying
  // the durable event schema encoder. Keep those already-published segments
  // replayable while all new captures normalize the transformed field.
  if (event.type === "session.next.location.rebound.1" && typeof event.data.timestamp === "string") {
    const timestamp = Date.parse(event.data.timestamp)
    if (Number.isFinite(timestamp)) return { ...event.data, timestamp }
  }
  return event.data
}

function normalizeCapturedData(type: string, data: Record<string, unknown>) {
  const normalized = JSON.parse(JSON.stringify(data)) as Record<string, any>
  if (type === "session.next.location.rebound" && typeof normalized.timestamp === "string") {
    const timestamp = Date.parse(normalized.timestamp)
    if (Number.isFinite(timestamp)) normalized.timestamp = timestamp
  }
  return normalized
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
    { publish: true, allowEquivalent: true, ...(ownerID ? { ownerID, strictOwner: true } : {}) },
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
  return SessionSyncDurable.definitions.get(event.type) === SessionV1.Event.Created
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
const captureEffect = Effect.gen(function* () {
  const events = yield* EventV2.Service
  const store = yield* SyncEventStore.Service
  const ownership = yield* SyncOwnership.Service
  const db = (yield* Database.Service).db
  const persisted = (sessionID: string) =>
    db
      .select({ spaceID: SessionTable.sync_space_id })
      .from(SessionTable)
      .where(eq(SessionTable.id, SessionV2.ID.make(sessionID)))
      .get()
      .pipe(
        Effect.map(
          (row): PersistedOwnership =>
            row ? { exists: true, ...(row.spaceID ? { spaceID: row.spaceID } : {}) } : { exists: false },
        ),
      )
  // Subscribe before taking the recovery snapshot. Any commit racing startup
  // is either observed live or appears in the subsequent durable backfill.
  const unsubscribe = yield* events.listen((event) =>
    captureOwned(ownership, store, event as DurablePayload, Date.now(), persisted).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Session sync live capture failed", { cause })),
    ),
  )
  yield* Effect.addFinalizer(() => unsubscribe)
  yield* Effect.gen(function* () {
    const existing = yield* db
      .select({
        sessionID: SessionTable.id,
        spaceID: SessionTable.sync_space_id,
        assignedAt: SessionTable.time_created,
      })
      .from(SessionTable)
      .all()
    yield* reconcileOwnership(
      ownership,
      existing.map((item) => ({
        sessionID: item.sessionID,
        ...(item.spaceID ? { spaceID: item.spaceID } : {}),
        assignedAt: item.assignedAt,
      })),
    )
    // Session and sync outbox use separate SQLite databases. Replaying the
    // owned durable history after the live subscriber starts closes the crash
    // window between a committed Session event and its asynchronous capture.
    // Enqueue is idempotent by event ID, so overlap with the live stream is safe.
    yield* Effect.forEach(yield* ownership.list(), (item) => backfill(db, store, item.sessionID, item.spaceID), {
      discard: true,
    })
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Session sync recovery failed", { cause })))
})

export const captureLayer = Layer.effectDiscard(captureEffect)

export class Capture extends Context.Service<Capture, true>()("@opencode/SessionSyncCapture") {}
const captureServiceLayer = Layer.effect(Capture, captureEffect.pipe(Effect.as(true)))
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
