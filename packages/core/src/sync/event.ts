export * as SyncEvent from "./event"

import { Effect, Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"

export const DeviceID = Schema.NonEmptyString.pipe(Schema.brand("SyncDeviceID"))
export type DeviceID = typeof DeviceID.Type

export const SegmentID = Schema.NonEmptyString.pipe(Schema.brand("SyncSegmentID"))
export type SegmentID = typeof SegmentID.Type

export const Cursor = NonNegativeInt
export type Cursor = typeof Cursor.Type

export const Envelope = Schema.Struct({
  id: Schema.NonEmptyString,
  aggregateID: Schema.NonEmptyString,
  seq: NonNegativeInt,
  type: Schema.NonEmptyString,
  data: Schema.Record(Schema.String, Schema.Json),
})
export type Envelope = typeof Envelope.Type

/** Tagged so tombstones and other monotonic control records can be added without overloading event payloads. */
export const EventOperation = Schema.Struct({ kind: Schema.Literal("event"), event: Envelope })
export const Tombstone = Schema.Struct({
  id: Schema.NonEmptyString,
  sessionID: Schema.NonEmptyString,
  deletedAt: NonNegativeInt,
})
export type Tombstone = typeof Tombstone.Type

export const TombstoneOperation = Schema.Struct({ kind: Schema.Literal("tombstone"), tombstone: Tombstone })
export const Operation = Schema.Union([EventOperation, TombstoneOperation])
export type Operation = typeof Operation.Type

export const Segment = Schema.Struct({
  version: Schema.Literal(1),
  id: SegmentID,
  deviceID: DeviceID,
  generation: PositiveInt,
  createdAt: NonNegativeInt,
  operations: Schema.Array(Operation),
})
export type Segment = typeof Segment.Type

/**
 * Projection is deliberately part of the store transaction. A remote cursor
 * may advance only when every event and its domain projection have committed.
 */
export interface Projector<Transaction> {
  readonly project: (transaction: Transaction, event: Envelope) => Effect.Effect<void, unknown>
  /** Removes both metadata projections and hydrated Session content. */
  readonly delete: (transaction: Transaction, tombstone: Tombstone) => Effect.Effect<void, unknown>
}

/**
 * Cross-database projection contract. Implementations must be idempotent by
 * operation ID because a crash can occur after projection and before cursor
 * commit, causing the durable apply journal to replay the operation.
 */
export interface DurableProjector {
  readonly project: (event: Envelope) => Effect.Effect<void, unknown>
  readonly delete: (tombstone: Tombstone) => Effect.Effect<void, unknown>
}
