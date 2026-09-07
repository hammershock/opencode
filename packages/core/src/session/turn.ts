export * as SessionTurn from "./turn"

import { and, asc, eq, sql } from "drizzle-orm"
import { DateTime, Effect, Option, Schema, Stream } from "effect"
import type { Database } from "../database/database"
import { EventV2 } from "../event"
import { EventTable } from "../event/sql"
import { SessionEvent } from "./event"
import { SessionInput } from "./input"
import { SessionMessage } from "./message"
import { SessionSchema } from "./schema"

type DatabaseService = Database.Interface["db"]

export type Outcome = SessionEvent.Turn.Outcome

const type = EventV2.versionedType(SessionEvent.Turn.Settled.type, 1)

const fromData = (data: Record<string, unknown>): Outcome | undefined => {
  if (data.outcome === "completed" || data.outcome === "failed" || data.outcome === "cancelled") return data.outcome
  return undefined
}

export const find = Effect.fn("SessionTurn.find")(function* (
  db: DatabaseService,
  input: { readonly sessionID: SessionSchema.ID; readonly messageID: SessionMessage.ID },
) {
  const row = yield* db
    .select({ data: EventTable.data })
    .from(EventTable)
    .where(
      and(
        eq(EventTable.aggregate_id, input.sessionID),
        eq(EventTable.type, type),
        sql`json_extract(${EventTable.data}, '$.messageID') = ${input.messageID}`,
      ),
    )
    .orderBy(asc(EventTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return row === undefined ? undefined : fromData(row.data)
})

class AlreadySettled extends Error {
  constructor(readonly outcome: Outcome) {
    super("Session turn is already settled")
  }
}

class NotPending extends Error {}

const publish = Effect.fn("SessionTurn.publish")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly messageID: SessionMessage.ID
    readonly outcome: Outcome
    readonly pending?: true
  },
) {
  const existing = yield* find(db, input)
  if (existing !== undefined) return existing
  const admitted = yield* SessionInput.find(db, input.messageID)
  if (admitted?.sessionID !== input.sessionID) return yield* Effect.die("Cannot settle an input that was not admitted")
  if (input.pending && admitted.promotedSeq !== undefined) return undefined
  const attempt = yield* events
    .publish(
      SessionEvent.Turn.Settled,
      {
        sessionID: input.sessionID,
        messageID: input.messageID,
        timestamp: yield* DateTime.now,
        outcome: input.outcome,
      },
      {
        commit: () =>
          Effect.gen(function* () {
            const stored = yield* find(db, input)
            if (stored !== undefined) return yield* Effect.die(new AlreadySettled(stored))
            if (input.pending) {
              const current = yield* SessionInput.find(db, input.messageID)
              if (current?.sessionID !== input.sessionID || current.promotedSeq !== undefined)
                return yield* Effect.die(new NotPending())
            }
            return yield* Effect.void
          }),
      },
    )
    .pipe(Effect.exit)
  if (attempt._tag === "Success") return input.outcome
  const conflict = attempt.cause.reasons.find(
    (reason) => reason._tag === "Die" && reason.defect instanceof AlreadySettled,
  )
  if (conflict?._tag === "Die" && conflict.defect instanceof AlreadySettled) return conflict.defect.outcome
  if (attempt.cause.reasons.some((reason) => reason._tag === "Die" && reason.defect instanceof NotPending))
    return undefined
  return yield* Effect.failCause(attempt.cause)
})

export const settle = Effect.fn("SessionTurn.settle")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: {
    readonly sessionID: SessionSchema.ID
    readonly messageIDs: ReadonlyArray<SessionMessage.ID>
    readonly outcome: Outcome
  },
) {
  yield* Effect.forEach(input.messageIDs, (messageID) => publish(db, events, { ...input, messageID }), {
    discard: true,
  })
})

export const cancelPending = Effect.fn("SessionTurn.cancelPending")(function* (
  db: DatabaseService,
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly messageID: SessionMessage.ID },
) {
  return (yield* publish(db, events, { ...input, outcome: "cancelled", pending: true })) === "cancelled"
})

export const awaitSettlement = (
  events: EventV2.Interface,
  input: { readonly sessionID: SessionSchema.ID; readonly messageID: SessionMessage.ID },
) =>
  events.durable({ aggregateID: input.sessionID }).pipe(
    Stream.filter(Schema.is(SessionEvent.Turn.Settled)),
    Stream.filter((event) => event.data.messageID === input.messageID),
    Stream.map((event) => event.data.outcome),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  )
