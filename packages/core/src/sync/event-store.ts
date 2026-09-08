export * as SyncEventStore from "./event-store"

import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { SyncDatabase } from "./database"
import { SyncEvent } from "./event"
import { makeGlobalNode } from "../effect/app-node"

type DB = SyncDatabase.Interface["db"]
export type Transaction = Parameters<Parameters<DB["transaction"]>[0]>[0]

export class CursorMismatchError extends Schema.TaggedErrorClass<CursorMismatchError>()(
  "SyncEventStore.CursorMismatch",
  { deviceID: SyncEvent.DeviceID, expected: SyncEvent.Cursor, received: SyncEvent.Cursor },
) {}

export class DivergentEventError extends Schema.TaggedErrorClass<DivergentEventError>()(
  "SyncEventStore.DivergentEvent",
  { deviceID: SyncEvent.DeviceID, eventID: Schema.String },
) {}

export interface Interface {
  readonly scope: (spaceID: string) => Interface
  readonly enqueue: (event: SyncEvent.Envelope, createdAt?: number) => Effect.Effect<void, unknown>
  readonly delete: (tombstone: SyncEvent.Tombstone, createdAt?: number) => Effect.Effect<void, unknown>
  readonly pending: (limit: number) => Effect.Effect<ReadonlyArray<SyncEvent.Envelope>, unknown>
  readonly seal: (
    deviceID: SyncEvent.DeviceID,
    limit: number,
    createdAt?: number,
  ) => Effect.Effect<SyncEvent.Segment | undefined, unknown>
  readonly acknowledge: (segmentID: SyncEvent.SegmentID) => Effect.Effect<void, unknown>
  readonly head: (deviceID: SyncEvent.DeviceID) => Effect.Effect<number, unknown>
  readonly cursor: (deviceID: SyncEvent.DeviceID) => Effect.Effect<number, unknown>
  readonly apply: (
    segment: SyncEvent.Segment,
    projector: SyncEvent.Projector<Transaction>,
  ) => Effect.Effect<void, unknown>
  readonly applyDurable: (
    segment: SyncEvent.Segment,
    projector: SyncEvent.DurableProjector,
  ) => Effect.Effect<void, unknown>
  readonly pendingApply: () => Effect.Effect<ReadonlyArray<SyncEvent.Segment>, unknown>
  readonly deletions: () => Effect.Effect<ReadonlyArray<SyncEvent.Tombstone>, unknown>
  readonly absorbDeletions: (
    tombstones: readonly SyncEvent.Tombstone[],
    projector: SyncEvent.DurableProjector,
  ) => Effect.Effect<void, unknown>
  readonly forgetDeletion: (sessionID: string) => Effect.Effect<void, unknown>
  readonly acquire: (name: string, owner: string, ttl: number, now?: number) => Effect.Effect<boolean, unknown>
  readonly renew: (name: string, owner: string, ttl: number, now?: number) => Effect.Effect<boolean, unknown>
  readonly release: (name: string, owner: string) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncEventStore") {}

type OutboxRow = { payload: string }
type OperationRow = { aggregate_id: string; payload: string; kind: "event" | "tombstone" }
type SegmentRow = { payload: string }
type NumberRow = { value: number }
type RemoteEventRow = { fingerprint: string }
type RemoteSegmentRow = { payload: string }
type LeaseRow = { owner: string; expires_at: number }
type ApplyJournalRow = { payload: string }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* SyncDatabase.Service).db

    const scoped = (spaceID: string): Interface => {
      const enqueue = Effect.fn("SyncEventStore.enqueue")(function* (
        event: SyncEvent.Envelope,
        createdAt = Date.now(),
      ) {
        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const deleted = yield* tx.get(sql`
              SELECT 1 FROM sync_deletion_set WHERE session_id = ${event.aggregateID} AND space_id = ${spaceID}
            `)
              if (deleted) return
              const payload = encodeEvent(event)
              yield* tx.run(sql`
              INSERT INTO sync_event_outbox (event_id, aggregate_id, seq, payload, created_at, kind, space_id)
              VALUES (${event.id}, ${event.aggregateID}, ${event.seq}, ${payload}, ${createdAt}, 'event', ${spaceID})
              ON CONFLICT(space_id, event_id) DO NOTHING
            `)
              const stored = yield* tx.get<OutboxRow>(sql`
              SELECT payload FROM sync_event_outbox WHERE event_id = ${event.id} AND space_id = ${spaceID}
            `)
              if (stored?.payload !== payload)
                return yield* Effect.die(new Error(`Sync outbox event ${event.id} has divergent payload`))
            }),
          { behavior: "immediate" },
        )
      })

      const remove = Effect.fn("SyncEventStore.delete")(function* (
        tombstone: SyncEvent.Tombstone,
        createdAt = Date.now(),
      ) {
        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const payload = canonical(tombstone)
              yield* tx.run(sql`
              DELETE FROM sync_event_outbox
              WHERE aggregate_id = ${tombstone.sessionID} AND segment_id IS NULL AND space_id = ${spaceID}
            `)
              yield* tx.run(sql`
              INSERT INTO sync_event_outbox (event_id, aggregate_id, seq, payload, created_at, kind, space_id)
              VALUES (${tombstone.id}, ${tombstone.sessionID}, 0, ${payload}, ${createdAt}, 'tombstone', ${spaceID})
              ON CONFLICT(space_id, event_id) DO NOTHING
            `)
              const stored = yield* tx.get<OperationRow>(sql`
              SELECT payload, kind FROM sync_event_outbox WHERE event_id = ${tombstone.id} AND space_id = ${spaceID}
            `)
              if (stored?.payload !== payload || stored.kind !== "tombstone")
                return yield* Effect.die(new Error(`Sync tombstone ${tombstone.id} has divergent payload`))
              yield* tx.run(sql`
              INSERT INTO sync_deletion_set (session_id, marker, deleted_at, space_id)
              VALUES (${tombstone.sessionID}, ${payload}, ${tombstone.deletedAt}, ${spaceID})
              ON CONFLICT(space_id, session_id) DO NOTHING
            `)
            }),
          { behavior: "immediate" },
        )
      })

      const pending = Effect.fn("SyncEventStore.pending")(function* (limit: number) {
        const rows = yield* db.all<OutboxRow>(sql`
        SELECT payload FROM sync_event_outbox
        WHERE segment_id IS NULL AND kind = 'event' AND space_id = ${spaceID}
        ORDER BY created_at, event_id
        LIMIT ${limit}
      `)
        return rows.map((row) => decodeEvent(row.payload))
      })

      const seal = Effect.fn("SyncEventStore.seal")(function* (
        deviceID: SyncEvent.DeviceID,
        limit: number,
        createdAt = Date.now(),
      ) {
        return yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const existing = yield* tx.get<SegmentRow>(sql`
              SELECT payload FROM sync_event_segment
              WHERE device_id = ${deviceID} AND acknowledged_at IS NULL AND space_id = ${spaceID}
              ORDER BY generation
              LIMIT 1
            `)
              if (existing) return decodeSegment(existing.payload)
              const first = yield* tx.get<{ aggregate_id: string }>(sql`
              SELECT aggregate_id FROM sync_event_outbox
              WHERE segment_id IS NULL AND space_id = ${spaceID}
              ORDER BY created_at, event_id
              LIMIT 1
            `)
              if (!first) return undefined
              const rows = yield* tx.all<OperationRow>(sql`
              SELECT aggregate_id, payload, kind FROM sync_event_outbox
              WHERE segment_id IS NULL AND space_id = ${spaceID} AND aggregate_id = ${first.aggregate_id}
              ORDER BY created_at, event_id
              LIMIT ${limit}
            `)
              if (rows.length === 0) return undefined
              const generation =
                (yield* tx.get<NumberRow>(sql`
                SELECT MAX(generation) AS value FROM sync_event_segment WHERE device_id = ${deviceID} AND space_id = ${spaceID}
              `))?.value ?? 0
              const next = generation + 1
              const segment = SyncEvent.Segment.make({
                version: 1,
                id: SyncEvent.SegmentID.make(`${deviceID}:${next}`),
                deviceID,
                generation: next,
                createdAt,
                operations: rows.map((row) =>
                  row.kind === "tombstone"
                    ? { kind: "tombstone" as const, tombstone: decodeTombstone(row.payload) }
                    : { kind: "event" as const, event: decodeEvent(row.payload) },
                ),
              })
              const payload = encodeSegment(segment)
              yield* tx.run(sql`
              INSERT INTO sync_event_segment (id, device_id, generation, payload, created_at, space_id)
              VALUES (${segment.id}, ${deviceID}, ${next}, ${payload}, ${createdAt}, ${spaceID})
            `)
              yield* tx.run(sql`
              UPDATE sync_event_outbox SET segment_id = ${segment.id}
              WHERE event_id IN (SELECT value FROM json_each(${JSON.stringify(segment.operations.map(operationID))}))
                AND space_id = ${spaceID}
            `)
              return segment
            }),
          { behavior: "immediate" },
        )
      })

      const acknowledge = Effect.fn("SyncEventStore.acknowledge")(function* (segmentID: SyncEvent.SegmentID) {
        yield* db.transaction((tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
            UPDATE sync_event_segment SET acknowledged_at = ${Date.now()}
            WHERE id = ${segmentID} AND acknowledged_at IS NULL AND space_id = ${spaceID}
          `)
            yield* tx.run(sql`
            INSERT INTO sync_event_head (device_id, generation, space_id)
            SELECT device_id, generation, space_id FROM sync_event_segment WHERE id = ${segmentID} AND space_id = ${spaceID}
            ON CONFLICT(space_id, device_id) DO UPDATE SET generation = MAX(generation, excluded.generation)
          `)
            yield* tx.run(sql`DELETE FROM sync_event_outbox WHERE segment_id = ${segmentID} AND space_id = ${spaceID}`)
          }),
        )
      })

      const head = Effect.fn("SyncEventStore.head")(function* (deviceID: SyncEvent.DeviceID) {
        return (
          (yield* db.get<NumberRow>(sql`
          SELECT generation AS value FROM sync_event_head WHERE device_id = ${deviceID} AND space_id = ${spaceID}
        `))?.value ?? 0
        )
      })

      const cursor = Effect.fn("SyncEventStore.cursor")(function* (deviceID: SyncEvent.DeviceID) {
        return (
          (yield* db.get<NumberRow>(sql`
          SELECT cursor AS value FROM sync_event_cursor WHERE device_id = ${deviceID} AND space_id = ${spaceID}
        `))?.value ?? 0
        )
      })

      const apply = Effect.fn("SyncEventStore.apply")(function* (
        segment: SyncEvent.Segment,
        projector: SyncEvent.Projector<Transaction>,
      ) {
        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const current =
                (yield* tx.get<NumberRow>(sql`
                SELECT cursor AS value FROM sync_event_cursor WHERE device_id = ${segment.deviceID} AND space_id = ${spaceID}
              `))?.value ?? 0
              const payload = encodeSegment(segment)
              const received = segment.generation - 1
              if (current >= segment.generation) {
                const stored = yield* tx.get<RemoteSegmentRow>(sql`
                SELECT payload FROM sync_remote_segment
                WHERE device_id = ${segment.deviceID} AND generation = ${segment.generation} AND space_id = ${spaceID}
              `)
                if (stored?.payload !== payload)
                  return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: segment.id })
                return
              }
              if (current !== received)
                return yield* new CursorMismatchError({ deviceID: segment.deviceID, expected: current, received })
              for (const operation of segment.operations) {
                const id = operationID(operation)
                const fingerprint = operationFingerprint(operation)
                const stored = yield* tx.get<RemoteEventRow>(sql`
                SELECT fingerprint FROM sync_remote_event
                WHERE device_id = ${segment.deviceID} AND event_id = ${id} AND space_id = ${spaceID}
              `)
                if (stored?.fingerprint === fingerprint) continue
                if (stored) return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: id })
                if (operation.kind === "tombstone") {
                  const marker = canonical(operation.tombstone)
                  yield* tx.run(sql`
                  INSERT INTO sync_deletion_set (session_id, marker, deleted_at, space_id)
                  VALUES (${operation.tombstone.sessionID}, ${marker}, ${operation.tombstone.deletedAt}, ${spaceID})
                  ON CONFLICT(space_id, session_id) DO NOTHING
                `)
                  yield* projector.delete(tx, operation.tombstone)
                } else {
                  const deleted = yield* tx.get(sql`
                  SELECT 1 FROM sync_deletion_set WHERE session_id = ${operation.event.aggregateID} AND space_id = ${spaceID}
                `)
                  if (!deleted) yield* projector.project(tx, operation.event)
                }
                yield* tx.run(sql`
                INSERT INTO sync_remote_event (device_id, event_id, fingerprint, space_id)
                VALUES (${segment.deviceID}, ${id}, ${fingerprint}, ${spaceID})
              `)
              }
              yield* tx.run(sql`
              INSERT INTO sync_remote_segment (device_id, generation, payload, space_id)
              VALUES (${segment.deviceID}, ${segment.generation}, ${payload}, ${spaceID})
            `)
              yield* tx.run(sql`
              INSERT INTO sync_event_cursor (device_id, cursor, space_id)
              VALUES (${segment.deviceID}, ${segment.generation}, ${spaceID})
              ON CONFLICT(space_id, device_id) DO UPDATE SET cursor = excluded.cursor
            `)
            }),
          { behavior: "immediate" },
        )
      })

      const pendingApply = Effect.fn("SyncEventStore.pendingApply")(function* () {
        const rows = yield* db.all<ApplyJournalRow>(sql`
        SELECT payload FROM sync_apply_journal WHERE space_id = ${spaceID} ORDER BY device_id, generation
      `)
        return rows.map((row) => decodeSegment(row.payload))
      })

      const deletions = Effect.fn("SyncEventStore.deletions")(function* () {
        const rows = yield* db.all<OutboxRow>(sql`
          SELECT marker AS payload FROM sync_deletion_set
          WHERE space_id = ${spaceID} ORDER BY session_id
        `)
        return rows.map((row) => decodeTombstone(row.payload))
      })

      const absorbDeletions = Effect.fn("SyncEventStore.absorbDeletions")(function* (
        tombstones: readonly SyncEvent.Tombstone[],
        projector: SyncEvent.DurableProjector,
      ) {
        yield* db.transaction(
          (tx) =>
            Effect.forEach(
              tombstones,
              (tombstone) => {
                const marker = canonical(tombstone)
                return Effect.all(
                  [
                    tx.run(sql`
                      INSERT INTO sync_deletion_set (session_id, marker, deleted_at, space_id)
                      VALUES (${tombstone.sessionID}, ${marker}, ${tombstone.deletedAt}, ${spaceID})
                      ON CONFLICT(space_id, session_id) DO NOTHING
                    `),
                    tx.run(sql`
                      DELETE FROM sync_event_outbox
                      WHERE aggregate_id = ${tombstone.sessionID} AND segment_id IS NULL AND space_id = ${spaceID}
                    `),
                  ],
                  { discard: true },
                )
              },
              { discard: true },
            ),
          { behavior: "immediate" },
        )
        // The durable projector can live in a different database. Repeating
        // this idempotent deletion repairs a crash between the monotonic fact
        // above and removal of the local Session projection.
        yield* Effect.forEach(tombstones, (tombstone) => projector.delete(tombstone), { discard: true })
      })
      const forgetDeletion = Effect.fn("SyncEventStore.forgetDeletion")((sessionID: string) =>
        db
          .run(sql`DELETE FROM sync_deletion_set WHERE session_id = ${sessionID} AND space_id = ${spaceID}`)
          .pipe(Effect.asVoid),
      )

      const applyDurable = Effect.fn("SyncEventStore.applyDurable")(function* (
        segment: SyncEvent.Segment,
        projector: SyncEvent.DurableProjector,
      ) {
        const payload = encodeSegment(segment)
        const staged = yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const current =
                (yield* tx.get<NumberRow>(sql`
                SELECT cursor AS value FROM sync_event_cursor WHERE device_id = ${segment.deviceID} AND space_id = ${spaceID}
              `))?.value ?? 0
              if (current >= segment.generation) {
                const stored = yield* tx.get<RemoteSegmentRow>(sql`
                SELECT payload FROM sync_remote_segment
                WHERE device_id = ${segment.deviceID} AND generation = ${segment.generation} AND space_id = ${spaceID}
              `)
                if (stored?.payload !== payload)
                  return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: segment.id })
                return false
              }
              const received = segment.generation - 1
              if (current !== received)
                return yield* new CursorMismatchError({ deviceID: segment.deviceID, expected: current, received })

              const journal = yield* tx.get<ApplyJournalRow>(sql`
              SELECT payload FROM sync_apply_journal
              WHERE device_id = ${segment.deviceID} AND generation = ${segment.generation} AND space_id = ${spaceID}
            `)
              if (journal && journal.payload !== payload)
                return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: segment.id })

              const fingerprints = new Map<string, string>()
              for (const operation of segment.operations) {
                const id = operationID(operation)
                const fingerprint = operationFingerprint(operation)
                const previous = fingerprints.get(id)
                if (previous !== undefined && previous !== fingerprint)
                  return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: id })
                fingerprints.set(id, fingerprint)
                const stored = yield* tx.get<RemoteEventRow>(sql`
                SELECT fingerprint FROM sync_remote_event
                WHERE device_id = ${segment.deviceID} AND event_id = ${id} AND space_id = ${spaceID}
              `)
                if (stored && stored.fingerprint !== fingerprint)
                  return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: id })
                if (operation.kind === "tombstone") {
                  const marker = canonical(operation.tombstone)
                  yield* tx.run(sql`
                  INSERT INTO sync_deletion_set (session_id, marker, deleted_at, space_id)
                  VALUES (${operation.tombstone.sessionID}, ${marker}, ${operation.tombstone.deletedAt}, ${spaceID})
                  ON CONFLICT(space_id, session_id) DO NOTHING
                `)
                }
              }
              if (!journal)
                yield* tx.run(sql`
                INSERT INTO sync_apply_journal (device_id, generation, payload, created_at, space_id)
                VALUES (${segment.deviceID}, ${segment.generation}, ${payload}, ${Date.now()}, ${spaceID})
              `)
              return true
            }),
          { behavior: "immediate" },
        )
        if (!staged) return

        for (const operation of segment.operations) {
          if (operation.kind === "tombstone") {
            yield* projector.delete(operation.tombstone)
            continue
          }
          const deleted = yield* db.get(sql`
          SELECT 1 FROM sync_deletion_set WHERE session_id = ${operation.event.aggregateID} AND space_id = ${spaceID}
        `)
          if (!deleted) yield* projector.project(operation.event)
        }

        yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              const current =
                (yield* tx.get<NumberRow>(sql`
                SELECT cursor AS value FROM sync_event_cursor WHERE device_id = ${segment.deviceID} AND space_id = ${spaceID}
              `))?.value ?? 0
              if (current !== segment.generation - 1)
                return yield* new CursorMismatchError({
                  deviceID: segment.deviceID,
                  expected: current,
                  received: segment.generation - 1,
                })
              const journal = yield* tx.get<ApplyJournalRow>(sql`
              SELECT payload FROM sync_apply_journal
              WHERE device_id = ${segment.deviceID} AND generation = ${segment.generation} AND space_id = ${spaceID}
            `)
              if (journal?.payload !== payload)
                return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: segment.id })
              for (const operation of segment.operations) {
                yield* tx.run(sql`
                INSERT INTO sync_remote_event (device_id, event_id, fingerprint, space_id)
                VALUES (${segment.deviceID}, ${operationID(operation)}, ${operationFingerprint(operation)}, ${spaceID})
                ON CONFLICT(space_id, device_id, event_id) DO NOTHING
              `)
              }
              yield* tx.run(sql`
              INSERT INTO sync_remote_segment (device_id, generation, payload, space_id)
              VALUES (${segment.deviceID}, ${segment.generation}, ${payload}, ${spaceID})
            `)
              yield* tx.run(sql`
              INSERT INTO sync_event_cursor (device_id, cursor, space_id)
              VALUES (${segment.deviceID}, ${segment.generation}, ${spaceID})
              ON CONFLICT(space_id, device_id) DO UPDATE SET cursor = excluded.cursor
            `)
              yield* tx.run(sql`
              DELETE FROM sync_apply_journal
              WHERE device_id = ${segment.deviceID} AND generation = ${segment.generation} AND space_id = ${spaceID}
            `)
            }),
          { behavior: "immediate" },
        )
      })

      const acquire = Effect.fn("SyncEventStore.acquire")(function* (
        name: string,
        owner: string,
        ttl: number,
        now = Date.now(),
      ) {
        const leaseName = `${spaceID}:${name}`
        return yield* db.transaction(
          (tx) =>
            Effect.gen(function* () {
              yield* tx.run(sql`DELETE FROM sync_event_lease WHERE name = ${leaseName} AND expires_at <= ${now}`)
              yield* tx.run(sql`
              INSERT INTO sync_event_lease (name, owner, expires_at)
              VALUES (${leaseName}, ${owner}, ${now + ttl})
              ON CONFLICT(name) DO NOTHING
            `)
              const lease = yield* tx.get<LeaseRow>(sql`
              SELECT owner, expires_at FROM sync_event_lease WHERE name = ${leaseName}
            `)
              return lease?.owner === owner
            }),
          { behavior: "immediate" },
        )
      })

      const renew = Effect.fn("SyncEventStore.renew")(function* (
        name: string,
        owner: string,
        ttl: number,
        now = Date.now(),
      ) {
        const leaseName = `${spaceID}:${name}`
        yield* db.run(sql`
        UPDATE sync_event_lease SET expires_at = ${now + ttl}
        WHERE name = ${leaseName} AND owner = ${owner} AND expires_at > ${now}
      `)
        const lease = yield* db.get<LeaseRow>(sql`
        SELECT owner, expires_at FROM sync_event_lease WHERE name = ${leaseName}
      `)
        return lease?.owner === owner && lease.expires_at === now + ttl
      })

      const release = Effect.fn("SyncEventStore.release")(function* (name: string, owner: string) {
        yield* db.run(sql`DELETE FROM sync_event_lease WHERE name = ${`${spaceID}:${name}`} AND owner = ${owner}`)
      })

      return {
        scope: scoped,
        enqueue,
        delete: remove,
        pending,
        seal,
        acknowledge,
        head,
        cursor,
        apply,
        applyDurable,
        pendingApply,
        deletions,
        absorbDeletions,
        forgetDeletion,
        acquire,
        renew,
        release,
      }
    }
    return scoped("legacy")
  }).pipe(Effect.orDie),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SyncDatabase.node] })

function encodeEvent(event: SyncEvent.Envelope) {
  return canonical(event)
}

function decodeEvent(value: string) {
  return Schema.decodeUnknownSync(SyncEvent.Envelope)(JSON.parse(value))
}

function decodeTombstone(value: string) {
  return Schema.decodeUnknownSync(SyncEvent.Tombstone)(JSON.parse(value))
}

function operationID(operation: SyncEvent.Operation) {
  return operation.kind === "event" ? operation.event.id : operation.tombstone.id
}

function operationFingerprint(operation: SyncEvent.Operation) {
  return operation.kind === "event" ? encodeEvent(operation.event) : canonical(operation)
}

function encodeSegment(segment: SyncEvent.Segment) {
  return canonical(segment)
}

function decodeSegment(value: string) {
  return Schema.decodeUnknownSync(SyncEvent.Segment)(JSON.parse(value))
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("Sync values must be JSON serializable")
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}
