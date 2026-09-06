import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { SessionActivity } from "../src/session/activity"
import { SessionSchema } from "../src/session/schema"

const sessionID = SessionSchema.ID.make("ses_activity")

describe("Session runtime activity", () => {
  test("tracks nested process and User Shell activity until finalizers complete", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const activity = yield* SessionActivity.Service
        const processDone = yield* Deferred.make<void>()
        const shellDone = yield* Deferred.make<void>()
        const process = yield* activity
          .withActivity(sessionID, "process_execution", Deferred.await(processDone))
          .pipe(Effect.forkChild)
        const shell = yield* activity
          .withActivity(sessionID, "user_shell", Deferred.await(shellDone))
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(new Set(yield* activity.blockers(sessionID))).toEqual(new Set(["process_execution", "user_shell"]))
        yield* Deferred.succeed(processDone, undefined)
        yield* Fiber.await(process)
        expect(yield* activity.blockers(sessionID)).toEqual(["user_shell"])
        yield* Deferred.succeed(shellDone, undefined)
        yield* Fiber.await(shell)
        expect(yield* activity.blockers(sessionID)).toEqual([])
      }).pipe(Effect.provide(SessionActivity.layer)),
    )
  })

  test("releases activity after interruption", async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        const activity = yield* SessionActivity.Service
        const fiber = yield* activity.withActivity(sessionID, "process_execution", Effect.never).pipe(Effect.forkChild)
        yield* Effect.yieldNow
        expect(yield* activity.blockers(sessionID)).toEqual(["process_execution"])
        yield* Fiber.interrupt(fiber)
        expect(yield* activity.blockers(sessionID)).toEqual([])
      }).pipe(Effect.provide(SessionActivity.layer)),
    )
  })
})
