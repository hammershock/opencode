import { describe, expect } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionRunCoordinator } from "@opencode-ai/core/session/run-coordinator"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SessionTurn } from "@opencode-ai/core/session/turn"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"

let drain: (sessionID: SessionV2.ID) => Effect.Effect<void> = () => Effect.void

const execution = Layer.effect(
  SessionExecution.Service,
  Effect.gen(function* () {
    const coordinator = yield* SessionRunCoordinator.make<SessionV2.ID, never>({
      drain: (sessionID) => drain(sessionID),
    })
    return SessionExecution.Service.of({
      active: coordinator.active,
      resume: coordinator.run,
      wake: coordinator.wake,
      wakeAndWait: coordinator.wakeAndWait,
      interrupt: coordinator.interrupt,
    })
  }),
)

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node, SessionV2.node]),
    [[SessionExecution.node, execution]],
  ),
)

const sessionID = SessionV2.ID.make("ses_prompt_turn_race")
const directory = AbsolutePath.make(process.cwd())

const setup = Effect.gen(function* () {
  const db = (yield* Database.Service).db
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: directory, sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "prompt-turn-race",
      directory,
      title: "prompt turn race",
      version: "test",
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  return { db, events: yield* EventV2.Service }
})

describe("SessionV2.promptTurn", () => {
  it.effect("waits for the pending-wake successor after an old run's final queue check", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const session = yield* SessionV2.Service
      const oldChecked = yield* Deferred.make<void>()
      const releaseOld = yield* Deferred.make<void>()
      let runs = 0
      drain = (id) =>
        Effect.gen(function* () {
          runs++
          // Snapshot pending work before pausing at the old run's settle boundary.
          const queued = yield* SessionInput.promoteNextQueued(context.db, context.events, id)
          if (runs === 1) {
            yield* Deferred.succeed(oldChecked, undefined)
            yield* Deferred.await(releaseOld)
            return yield* Effect.die("unrelated old run failed after its final queue check")
          }
          if (!queued) return yield* Effect.void
          yield* SessionTurn.settle(context.db, context.events, {
            sessionID: id,
            messageIDs: [queued.id],
            outcome: "completed",
          })
        })

      const old = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(oldChecked)
      const exact = yield* session
        .promptTurn({ sessionID, prompt: { text: "Initialize the environment" } })
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      yield* Deferred.succeed(releaseOld, undefined)

      expect(yield* Fiber.join(exact)).toBe("completed")
      expect((yield* Fiber.await(old))._tag).toBe("Failure")
      expect(runs).toBe(2)
    }).pipe(Effect.ensuring(Effect.sync(() => (drain = () => Effect.void)))),
  )

  it.effect("durably cancels an interrupted pending turn so a successor cannot revive it", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const session = yield* SessionV2.Service
      const oldChecked = yield* Deferred.make<void>()
      const releaseOld = yield* Deferred.make<void>()
      const admitted = yield* Deferred.make<void>()
      const messageID = SessionMessage.ID.create()
      let runs = 0
      yield* context.events.listen((event) =>
        Schema.is(SessionEvent.PromptAdmitted)(event) && event.data.messageID === messageID
          ? Deferred.succeed(admitted, undefined)
          : Effect.void,
      )
      drain = (id) =>
        Effect.gen(function* () {
          runs++
          const queued = yield* SessionInput.promoteNextQueued(context.db, context.events, id)
          if (runs === 1) {
            yield* Deferred.succeed(oldChecked, undefined)
            yield* Deferred.await(releaseOld)
          }
          if (!queued) return yield* Effect.void
          yield* SessionTurn.settle(context.db, context.events, {
            sessionID: id,
            messageIDs: [queued.id],
            outcome: "completed",
          })
        })

      const old = yield* session.resume(sessionID).pipe(Effect.forkChild)
      yield* Deferred.await(oldChecked)
      const exact = yield* session
        .promptTurn({ id: messageID, sessionID, prompt: { text: "Cancel environment initialization" } })
        .pipe(Effect.forkChild)
      yield* Deferred.await(admitted)
      yield* Fiber.interrupt(exact)
      yield* Deferred.succeed(releaseOld, undefined)
      yield* Fiber.join(old)

      expect(yield* SessionTurn.find(context.db, { sessionID, messageID })).toBe("cancelled")
      expect((yield* SessionInput.find(context.db, messageID))?.promotedSeq).toBeUndefined()
      expect(yield* SessionInput.promoteNextQueued(context.db, context.events, sessionID)).toBeUndefined()
    }).pipe(Effect.ensuring(Effect.sync(() => (drain = () => Effect.void)))),
  )

  it.effect("durably fails its own pre-promotion execution failure without a hot retry", () =>
    Effect.gen(function* () {
      const context = yield* setup
      const session = yield* SessionV2.Service
      const messageID = SessionMessage.ID.create()
      let runs = 0
      drain = () => Effect.sync(() => runs++).pipe(Effect.andThen(Effect.die("system context unavailable")))

      expect(
        yield* session.promptTurn({ id: messageID, sessionID, prompt: { text: "Initialize the environment" } }),
      ).toBe("failed")
      expect(runs).toBe(1)
      expect(yield* SessionTurn.find(context.db, { sessionID, messageID })).toBe("failed")
      expect((yield* SessionInput.find(context.db, messageID))?.promotedSeq).toBeUndefined()
      expect(yield* SessionInput.promoteNextQueued(context.db, context.events, sessionID)).toBeUndefined()
    }).pipe(Effect.ensuring(Effect.sync(() => (drain = () => Effect.void)))),
  )
})
