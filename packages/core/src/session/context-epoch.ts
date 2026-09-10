export * as SessionContextEpoch from "./context-epoch"

import { asc, and, eq, gt } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { SystemContext } from "../system-context/index"
import { ContextSnapshotDecodeError } from "./error"
import { SessionEvent } from "./event"
import { SessionHistory } from "./history"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"
import { SessionContextEpochTable, SessionMessageTable } from "./sql"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { Hash } from "../util/hash"
import { KeyedMutex } from "../effect/keyed-mutex"

type DatabaseService = Database.Interface["db"]
const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

interface Prepared {
  readonly baseline: string
  readonly baselineSeq: number
}

export interface PromptContext extends Prepared {
  /** Durable context deltas after the active generation baseline, in aggregate order. */
  readonly advances: ReadonlyArray<string>
}

export interface Activation<A> {
  readonly status: "initialized" | "advanced" | "unchanged"
  readonly value: A
}

export function initialize(
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
): Effect.Effect<Prepared | undefined, SystemContext.InitializationBlocked> {
  return locks
    .withLock(sessionID)(initializeOnce(db, events, context, sessionID, locationRevision))
    .pipe(Effect.withSpan("SessionContextEpoch.initialize"))
}

export function prepare(
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
): Effect.Effect<Prepared, SystemContext.InitializationBlocked | ContextSnapshotDecodeError> {
  return locks
    .withLock(sessionID)(prepareOnce(db, events, context, sessionID, locationRevision))
    .pipe(Effect.withSpan("SessionContextEpoch.prepare"))
}

export function activate<A, E, R>(
  db: DatabaseService,
  events: EventV2.Interface,
  load: Effect.Effect<{ readonly context: SystemContext.SystemContext; readonly value: A }, E, R>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
): Effect.Effect<Activation<A>, E | SystemContext.InitializationBlocked | ContextSnapshotDecodeError, R> {
  return locks
    .withLock(sessionID)(activateOnce(db, events, load, sessionID, locationRevision))
    .pipe(Effect.withSpan("SessionContextEpoch.activate"))
}

/**
 * Resolve the exact durable context prefix consumed by legacy prompt callers.
 * Core V2 obtains the same advances through SessionHistory; keeping this query
 * here prevents the legacy path from inventing another instruction lifecycle.
 */
export const forPrompt = Effect.fn("SessionContextEpoch.forPrompt")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
) {
  const prepared = yield* prepare(db, events, context, sessionID, locationRevision)
  const rows = yield* db
    .select({ data: SessionMessageTable.data })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        eq(SessionMessageTable.type, "system"),
        gt(SessionMessageTable.seq, prepared.baselineSeq),
      ),
    )
    .orderBy(asc(SessionMessageTable.seq))
    .all()
    .pipe(Effect.orDie)
  const advances = rows.flatMap((row) => {
    const decoded = Schema.decodeUnknownOption(SessionMessage.System)(row.data)
    return decoded._tag === "Some" && decoded.value.text.length > 0 ? [decoded.value.text] : []
  })
  return { ...prepared, advances } satisfies PromptContext
})

const prepareOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
) {
  const [value, stored, compaction] = yield* Effect.all(
    [context, find(db, sessionID), SessionHistory.latestCompaction(db, sessionID)],
    { concurrency: "unbounded" },
  )
  if (!stored) {
    const generation = yield* SystemContext.initialize(value)
    const baselineSeq = yield* establish(events, sessionID, generation, {
      generation: 1,
      reason: "legacy-backfill",
      locationRevision,
    })
    return { baseline: generation.baseline, baselineSeq }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const replacementSeq = compaction !== undefined && compaction.seq > stored.baseline_seq ? compaction.seq : undefined
  const result = replacementSeq
    ? SystemContext.rebaseline(value, snapshot)
    : yield* SystemContext.reconcile(value, snapshot)
  if (result._tag === "Unchanged" || result._tag === "ReplacementBlocked") {
    return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
  }
  if (result._tag === "ReplacementReady") {
    const baselineSeq = replacementSeq ?? (yield* EventV2.latestSequence(db, sessionID))
    yield* replace(db, sessionID, baselineSeq, result.generation)
    return { baseline: result.generation.baseline, baselineSeq }
  }

  yield* events.publish(SessionEvent.ContextAdvanced, {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    cause: "dynamic",
    text: result.text,
    sources: result.snapshot,
    digest: digest(result.snapshot),
  })
  return { baseline: stored.baseline, baselineSeq: stored.baseline_seq }
})

const initializeOnce = Effect.fnUntraced(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  context: Effect.Effect<SystemContext.SystemContext>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
) {
  if (yield* exists(db, sessionID)) return
  const generation = yield* context.pipe(Effect.flatMap(SystemContext.initialize))
  const baselineSeq = yield* establish(events, sessionID, generation, {
    generation: 1,
    reason: "created",
    locationRevision,
  })
  return { baseline: generation.baseline, baselineSeq }
})

const activateOnce = Effect.fnUntraced(function* <A, E, R>(
  db: DatabaseService,
  events: EventV2.Interface,
  load: Effect.Effect<{ readonly context: SystemContext.SystemContext; readonly value: A }, E, R>,
  sessionID: SessionSchema.ID,
  locationRevision: number,
) {
  const loaded = yield* load
  const stored = yield* find(db, sessionID)
  if (!stored) {
    const generation = yield* SystemContext.initialize(loaded.context)
    yield* establish(events, sessionID, generation, { generation: 1, reason: "created", locationRevision })
    return { status: "initialized" as const, value: loaded.value }
  }

  const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(stored.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const result = yield* SystemContext.reconcileActivation(loaded.context, snapshot)
  if (result._tag === "Unchanged") return { status: "unchanged" as const, value: loaded.value }
  yield* events.publish(SessionEvent.ContextAdvanced, {
    sessionID,
    messageID: SessionMessage.ID.create(),
    timestamp: yield* DateTime.now,
    cause: "skill-catalog-reloaded",
    text: result.text,
    sources: result.snapshot,
    digest: digest(result.snapshot),
  })
  return { status: "advanced" as const, value: loaded.value }
})

const exists = Effect.fn("SessionContextEpoch.exists")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (
    (yield* db
      .select({ sessionID: SessionContextEpochTable.session_id })
      .from(SessionContextEpochTable)
      .where(eq(SessionContextEpochTable.session_id, sessionID))
      .get()
      .pipe(Effect.orDie)) !== undefined
  )
})

const find = Effect.fn("SessionContextEpoch.find")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

/** Read the frozen canonical generation without observing Location services. */
export const inspect = Effect.fn("SessionContextEpoch.inspect")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  const row = yield* find(db, sessionID)
  if (!row) return
  const sources = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(row.snapshot).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const environmentSource = sources[SystemContext.Key.make("core/environment")]
  const instructionSource = sources[SystemContext.Key.make("core/instructions")]
  const environment = yield* Schema.decodeUnknownEffect(ModelContext.Environment)(environmentSource?.value).pipe(
    Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
  )
  const instructions = instructionSource
    ? yield* Schema.decodeUnknownEffect(ModelContext.Instructions)(instructionSource.value).pipe(
        Effect.mapError((error) => new ContextSnapshotDecodeError({ sessionID, details: String(error) })),
      )
    : ModelContext.Instructions.make([])
  return ModelContext.Generation.make({
    version: 1,
    generation: row.generation,
    reason: row.reason,
    locationRevision: row.location_revision,
    environment,
    instructions,
    digest: row.digest || digest(sources),
    baseline: row.baseline,
    sources,
  })
})

export const reset = Effect.fn("SessionContextEpoch.reset")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  yield* db
    .delete(SessionContextEpochTable)
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

const establish = Effect.fnUntraced(function* (
  events: EventV2.Interface,
  sessionID: SessionSchema.ID,
  generation: SystemContext.Generation,
  metadata: {
    readonly generation: number
    readonly reason: ModelContext.GenerationReason
    readonly locationRevision: number
  },
) {
  const context = materialize(generation, metadata)
  const event = yield* events.publish(SessionEvent.ContextGenerationEstablished, {
    sessionID,
    timestamp: yield* DateTime.now,
    context,
  })
  if (event.durable === undefined) return yield* Effect.die("Context generation event was not durable")
  return event.durable.seq
})

const replace = Effect.fnUntraced(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  baselineSeq: number,
  generation: SystemContext.Generation,
) {
  const updated = yield* db
    .update(SessionContextEpochTable)
    .set({
      baseline: generation.baseline,
      snapshot: generation.snapshot,
      baseline_seq: baselineSeq,
      digest: digest(generation.snapshot),
    })
    .where(eq(SessionContextEpochTable.session_id, sessionID))
    .returning({ sessionID: SessionContextEpochTable.session_id })
    .get()
    .pipe(Effect.orDie)
  if (!updated) return yield* Effect.die("Context Epoch not found")
})

export function materialize(
  generation: SystemContext.Generation,
  metadata: {
    readonly generation: number
    readonly reason: ModelContext.GenerationReason
    readonly locationRevision: number
  },
) {
  const environment = Schema.decodeUnknownSync(ModelContext.Environment)(generation.snapshot["core/environment"]?.value)
  const instructions = generation.snapshot["core/instructions"]
    ? Schema.decodeUnknownSync(ModelContext.Instructions)(generation.snapshot["core/instructions"]!.value)
    : ModelContext.Instructions.make([])
  return ModelContext.Generation.make({
    version: 1,
    ...metadata,
    environment,
    instructions,
    digest: digest(generation.snapshot),
    baseline: generation.baseline,
    sources: generation.snapshot,
  })
}

/** Digest only the durable Location context; controller time and unrelated dynamic sources do not change it. */
export function digest(snapshot: SystemContext.Snapshot) {
  return Hash.sha256(
    stable({
      environment: snapshot["core/environment"]?.value ?? null,
      instructions: snapshot["core/instructions"]?.value ?? [],
    }),
  )
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
      .join(",")}}`
  return JSON.stringify(value)
}
