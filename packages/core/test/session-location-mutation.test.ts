import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { SessionLocationMutation } from "../src/session/location-mutation"
import { SessionActivity } from "../src/session/activity"
import { SessionSchema } from "../src/session/schema"

test("serializes Session creation, sync replay, rebind and binding commits", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const mutation = yield* SessionLocationMutation.Service
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const order: string[] = []
      const first = yield* mutation
        .withLock(
          Effect.gen(function* () {
            order.push("first.enter")
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
            order.push("first.exit")
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const second = yield* mutation.withLock(Effect.sync(() => order.push("second.enter"))).pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(order).toEqual(["first.enter"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(first)
      yield* Fiber.join(second)
      expect(order).toEqual(["first.enter", "first.exit", "second.enter"])
    }).pipe(Effect.provide(SessionLocationMutation.layer)),
  ))

test("Location commit gate observes an activity admitted before it", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const activity = yield* SessionActivity.Service
      const sessionID = SessionSchema.ID.make("ses_atomic_before")
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const running = yield* activity
        .withActivity(
          sessionID,
          "user_shell",
          Effect.gen(function* () {
            yield* Deferred.succeed(entered, undefined)
            yield* Deferred.await(release)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      const observed = yield* activity.withExclusive([sessionID], activity.blockers(sessionID))
      expect(observed).toEqual(["user_shell"])
      yield* Deferred.succeed(release, undefined)
      yield* Fiber.join(running)
    }).pipe(Effect.provide(SessionActivity.layer)),
  ))

test("Location commit gate prevents a new activity from entering during commit", async () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const activity = yield* SessionActivity.Service
      const sessionID = SessionSchema.ID.make("ses_atomic_commit")
      const commitEntered = yield* Deferred.make<void>()
      const releaseCommit = yield* Deferred.make<void>()
      const activityEntered = yield* Deferred.make<void>()
      const commit = yield* activity
        .withExclusive(
          [sessionID],
          Effect.gen(function* () {
            expect(yield* activity.blockers(sessionID)).toEqual([])
            yield* Deferred.succeed(commitEntered, undefined)
            yield* Deferred.await(releaseCommit)
          }),
        )
        .pipe(Effect.forkChild)
      yield* Deferred.await(commitEntered)
      const operation = yield* activity
        .withActivity(sessionID, "session_mutation", Deferred.succeed(activityEntered, undefined))
        .pipe(Effect.forkChild)
      yield* Effect.yieldNow
      expect(yield* Deferred.isDone(activityEntered)).toBe(false)
      yield* Deferred.succeed(releaseCommit, undefined)
      yield* Fiber.join(commit)
      yield* Fiber.join(operation)
      expect(yield* Deferred.isDone(activityEntered)).toBe(true)
    }).pipe(Effect.provide(SessionActivity.layer)),
  ))
