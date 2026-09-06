export * as SyncEventStore from "./event-store"

import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { SyncDatabase } from "./database"
import { SyncEvent } from "./event"

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
  readonly enqueue: (event: SyncEvent.Envelope, createdAt?: number) => Effect.Effect<void, unknown>
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
  readonly acquire: (name: string, owner: string, ttl: number, now?: number) => Effect.Effect<boolean, unknown>
  readonly renew: (name: string, owner: string, ttl: number, now?: number) => Effect.Effect<boolean, unknown>
  readonly release: (name: string, owner: string) => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncEventStore") {}

type OutboxRow = { payload: string }
type SegmentRow = { payload: string }
type NumberRow = { value: number }
type RemoteEventRow = { fingerprint: string }
type RemoteSegmentRow = { payload: string }
type LeaseRow = { owner: string; expires_at: number }

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* SyncDatabase.Service).db

    const enqueue = Effect.fn("SyncEventStore.enqueue")(function* (event: SyncEvent.Envelope, createdAt = Date.now()) {
      yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const payload = encodeEvent(event)
            yield* tx.run(sql`
              INSERT INTO sync_event_outbox (event_id, aggregate_id, seq, payload, created_at)
              VALUES (${event.id}, ${event.aggregateID}, ${event.seq}, ${payload}, ${createdAt})
              ON CONFLICT(event_id) DO NOTHING
            `)
            const stored = yield* tx.get<OutboxRow>(sql`
              SELECT payload FROM sync_event_outbox WHERE event_id = ${event.id}
            `)
            if (stored?.payload !== payload)
              return yield* Effect.die(new Error(`Sync outbox event ${event.id} has divergent payload`))
          }),
        { behavior: "immediate" },
      )
    })

    const pending = Effect.fn("SyncEventStore.pending")(function* (limit: number) {
      const rows = yield* db.all<OutboxRow>(sql`
        SELECT payload FROM sync_event_outbox
        WHERE segment_id IS NULL
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
              WHERE device_id = ${deviceID} AND acknowledged_at IS NULL
              ORDER BY generation
              LIMIT 1
            `)
            if (existing) return decodeSegment(existing.payload)
            const rows = yield* tx.all<OutboxRow>(sql`
              SELECT payload FROM sync_event_outbox
              WHERE segment_id IS NULL
              ORDER BY created_at, event_id
              LIMIT ${limit}
            `)
            if (rows.length === 0) return undefined
            const generation =
              (yield* tx.get<NumberRow>(sql`
                SELECT MAX(generation) AS value FROM sync_event_segment WHERE device_id = ${deviceID}
              `))?.value ?? 0
            const next = generation + 1
            const segment = SyncEvent.Segment.make({
              version: 1,
              id: SyncEvent.SegmentID.make(`${deviceID}:${next}`),
              deviceID,
              generation: next,
              createdAt,
              operations: rows.map((row) => ({ kind: "event" as const, event: decodeEvent(row.payload) })),
            })
            const payload = encodeSegment(segment)
            yield* tx.run(sql`
              INSERT INTO sync_event_segment (id, device_id, generation, payload, created_at)
              VALUES (${segment.id}, ${deviceID}, ${next}, ${payload}, ${createdAt})
            `)
            yield* tx.run(sql`
              UPDATE sync_event_outbox SET segment_id = ${segment.id}
              WHERE event_id IN (SELECT value FROM json_each(${JSON.stringify(segment.operations.map((item) => item.event.id))}))
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
            WHERE id = ${segmentID} AND acknowledged_at IS NULL
          `)
          yield* tx.run(sql`
            INSERT INTO sync_event_head (device_id, generation)
            SELECT device_id, generation FROM sync_event_segment WHERE id = ${segmentID}
            ON CONFLICT(device_id) DO UPDATE SET generation = MAX(generation, excluded.generation)
          `)
          yield* tx.run(sql`DELETE FROM sync_event_outbox WHERE segment_id = ${segmentID}`)
        }),
      )
    })

    const head = Effect.fn("SyncEventStore.head")(function* (deviceID: SyncEvent.DeviceID) {
      return (
        (yield* db.get<NumberRow>(sql`
          SELECT generation AS value FROM sync_event_head WHERE device_id = ${deviceID}
        `))?.value ?? 0
      )
    })

    const cursor = Effect.fn("SyncEventStore.cursor")(function* (deviceID: SyncEvent.DeviceID) {
      return (
        (yield* db.get<NumberRow>(sql`
          SELECT cursor AS value FROM sync_event_cursor WHERE device_id = ${deviceID}
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
                SELECT cursor AS value FROM sync_event_cursor WHERE device_id = ${segment.deviceID}
              `))?.value ?? 0
            const payload = encodeSegment(segment)
            const received = segment.generation - 1
            if (current === segment.generation) {
              const stored = yield* tx.get<RemoteSegmentRow>(sql`
                SELECT payload FROM sync_remote_segment
                WHERE device_id = ${segment.deviceID} AND generation = ${segment.generation}
              `)
              if (stored?.payload !== payload)
                return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: segment.id })
              return
            }
            if (current !== received)
              return yield* new CursorMismatchError({ deviceID: segment.deviceID, expected: current, received })
            for (const operation of segment.operations) {
              const event = operation.event
              const fingerprint = encodeEvent(event)
              const stored = yield* tx.get<RemoteEventRow>(sql`
                SELECT fingerprint FROM sync_remote_event
                WHERE device_id = ${segment.deviceID} AND event_id = ${event.id}
              `)
              if (stored?.fingerprint === fingerprint) continue
              if (stored) return yield* new DivergentEventError({ deviceID: segment.deviceID, eventID: event.id })
              yield* projector.project(tx, event)
              yield* tx.run(sql`
                INSERT INTO sync_remote_event (device_id, event_id, fingerprint)
                VALUES (${segment.deviceID}, ${event.id}, ${fingerprint})
              `)
            }
            yield* tx.run(sql`
              INSERT INTO sync_remote_segment (device_id, generation, payload)
              VALUES (${segment.deviceID}, ${segment.generation}, ${payload})
            `)
            yield* tx.run(sql`
              INSERT INTO sync_event_cursor (device_id, cursor)
              VALUES (${segment.deviceID}, ${segment.generation})
              ON CONFLICT(device_id) DO UPDATE SET cursor = excluded.cursor
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
      return yield* db.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`DELETE FROM sync_event_lease WHERE name = ${name} AND expires_at <= ${now}`)
            yield* tx.run(sql`
              INSERT INTO sync_event_lease (name, owner, expires_at)
              VALUES (${name}, ${owner}, ${now + ttl})
              ON CONFLICT(name) DO NOTHING
            `)
            const lease = yield* tx.get<LeaseRow>(sql`
              SELECT owner, expires_at FROM sync_event_lease WHERE name = ${name}
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
      yield* db.run(sql`
        UPDATE sync_event_lease SET expires_at = ${now + ttl}
        WHERE name = ${name} AND owner = ${owner} AND expires_at > ${now}
      `)
      const lease = yield* db.get<LeaseRow>(sql`
        SELECT owner, expires_at FROM sync_event_lease WHERE name = ${name}
      `)
      return lease?.owner === owner && lease.expires_at === now + ttl
    })

    const release = Effect.fn("SyncEventStore.release")(function* (name: string, owner: string) {
      yield* db.run(sql`DELETE FROM sync_event_lease WHERE name = ${name} AND owner = ${owner}`)
    })

    return { enqueue, pending, seal, acknowledge, head, cursor, apply, acquire, renew, release }
  }).pipe(Effect.orDie),
)

function encodeEvent(event: SyncEvent.Envelope) {
  return canonical(event)
}

function decodeEvent(value: string) {
  return Schema.decodeUnknownSync(SyncEvent.Envelope)(JSON.parse(value))
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
