import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTurn } from "@opencode-ai/core/session/turn"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  const sessionID = SessionSchema.ID.make(`ses_turn_${SessionMessage.ID.create().slice(4)}`)
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "turn",
      directory: "/project",
      title: "turn",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return { db, events: yield* EventV2.Service, sessionID }
})

const admit = (
  context: {
    readonly db: Database.Interface["db"]
    readonly events: EventV2.Interface
    readonly sessionID: SessionSchema.ID
  },
  text: string,
  delivery: SessionInput.Delivery = "queue",
) =>
  SessionInput.admit(context.db, context.events, {
    id: SessionMessage.ID.create(),
    sessionID: context.sessionID,
    prompt: Prompt.make({ text }),
    delivery,
  })

describe("SessionTurn", () => {
  it.effect("persists terminal outcomes keyed by the exact admitted message", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const inputs = yield* Effect.forEach(["completed", "failed", "cancelled"] as const, (outcome) =>
        admit(context, outcome).pipe(Effect.map((input) => ({ input, outcome }))),
      )

      for (const item of inputs) {
        yield* SessionTurn.settle(context.db, context.events, {
          sessionID: context.sessionID,
          messageIDs: [item.input.id],
          outcome: item.outcome,
        })
        expect(yield* SessionTurn.find(context.db, { sessionID: context.sessionID, messageID: item.input.id })).toBe(
          item.outcome,
        )
      }

      const rows = yield* context.db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.Turn.Settled.type, 1)))
        .all()
        .pipe(Effect.orDie)
      expect(rows.map((row) => Object.keys(row.data).sort())).toEqual([
        ["messageID", "outcome", "sessionID", "timestamp"],
        ["messageID", "outcome", "sessionID", "timestamp"],
        ["messageID", "outcome", "sessionID", "timestamp"],
      ])
    }),
  )

  it.effect("keeps the first terminal settlement across retries", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const input = yield* admit(context, "retry")
      yield* Effect.forEach(
        ["completed", "failed"] as const,
        (outcome) =>
          SessionTurn.settle(context.db, context.events, {
            sessionID: context.sessionID,
            messageIDs: [input.id],
            outcome,
          }),
        { concurrency: "unbounded", discard: true },
      )
      const outcome = yield* SessionTurn.find(context.db, {
        sessionID: context.sessionID,
        messageID: input.id,
      })
      expect(outcome === "completed" || outcome === "failed").toBe(true)
      yield* SessionTurn.settle(context.db, context.events, {
        sessionID: context.sessionID,
        messageIDs: [input.id],
        outcome: outcome === "completed" ? "failed" : "completed",
      })
      expect(yield* SessionTurn.find(context.db, { sessionID: context.sessionID, messageID: input.id })).toBe(outcome)
    }),
  )

  it.effect("never promotes a cancelled pending input and preserves FIFO", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const first = yield* admit(context, "first")
      const second = yield* admit(context, "second")
      expect(
        yield* SessionTurn.cancelPending(context.db, context.events, {
          sessionID: context.sessionID,
          messageID: first.id,
        }),
      ).toBe(true)

      const promoted = yield* SessionInput.promoteNextQueued(context.db, context.events, context.sessionID)
      expect(promoted?.id).toBe(second.id)
      expect((yield* SessionInput.find(context.db, first.id))?.promotedSeq).toBeUndefined()
      expect(yield* SessionInput.promoteNextQueued(context.db, context.events, context.sessionID)).toBeUndefined()
    }),
  )

  it.effect("does not cancel an input after promotion", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const input = yield* admit(context, "active")
      expect((yield* SessionInput.promoteNextQueued(context.db, context.events, context.sessionID))?.id).toBe(input.id)
      expect(
        yield* SessionTurn.cancelPending(context.db, context.events, {
          sessionID: context.sessionID,
          messageID: input.id,
        }),
      ).toBe(false)
      expect(yield* SessionTurn.find(context.db, { sessionID: context.sessionID, messageID: input.id })).toBeUndefined()
    }),
  )

  it.effect("replays historical settlement to an exact waiter without matching another input", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const first = yield* admit(context, "first")
      const second = yield* admit(context, "second")
      const pending = yield* SessionTurn.awaitSettlement(context.events, {
        sessionID: context.sessionID,
        messageID: first.id,
      }).pipe(Effect.forkScoped)
      yield* SessionTurn.settle(context.db, context.events, {
        sessionID: context.sessionID,
        messageIDs: [second.id],
        outcome: "completed",
      })
      yield* SessionTurn.settle(context.db, context.events, {
        sessionID: context.sessionID,
        messageIDs: [first.id],
        outcome: "failed",
      })
      expect(yield* Fiber.join(pending)).toBe("failed")
      expect(
        yield* SessionTurn.awaitSettlement(context.events, {
          sessionID: context.sessionID,
          messageID: second.id,
        }),
      ).toBe("completed")
    }),
  )
})
