import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Layer } from "effect"
import * as TestClock from "effect/testing/TestClock"
import { UserShellRuntime, type Provider } from "@/session/user-shell-runtime"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionLocationRuntime } from "@opencode-ai/core/session/location-runtime"

const location = { target: "local", directory: "/workspace" }

function provider(input?: { finalCwd?: string; valid?: boolean }): Provider {
  return {
    execute: () => Effect.succeed({ exitCode: 0, finalCwd: input?.finalCwd }),
    validateDirectory: (directory) => Effect.succeed(input?.valid === false ? undefined : directory),
    complete: () => Effect.succeed({ candidates: [] }),
  }
}

const runtimeLayer = UserShellRuntime.layer.pipe(
  Layer.provideMerge(SessionActivity.layer),
  Layer.provideMerge(SessionLocationRuntime.layer),
)

function runtime<A, E>(
  effect: Effect.Effect<A, E, UserShellRuntime.Service | SessionActivity.Service | SessionLocationRuntime.Service>,
) {
  return Effect.runPromise(effect.pipe(Effect.provide(runtimeLayer), Effect.scoped, Effect.provide(TestClock.layer())))
}

describe("UserShellRuntime", () => {
  test("inherits only validated cwd while enabled", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        expect(yield* service.current({ sessionID: "one", location, enabled: true })).toBe("/workspace")
        yield* service.execute({
          sessionID: "one",
          location,
          command: "cd child",
          environment: {},
          enabled: true,
          provider: provider({ finalCwd: "/workspace/child" }),
        })
        expect(yield* service.current({ sessionID: "one", location, enabled: true })).toBe("/workspace/child")
      }),
    ))

  test("rejects invalid cwd and clears state when disabled", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        yield* service.execute({
          sessionID: "one",
          location,
          command: "cd missing",
          environment: {},
          enabled: true,
          provider: provider({ finalCwd: "/missing", valid: false }),
        })
        expect(yield* service.current({ sessionID: "one", location, enabled: true })).toBe("/workspace")
        yield* service.execute({
          sessionID: "one",
          location,
          command: "cd child",
          environment: {},
          enabled: true,
          provider: provider({ finalCwd: "/workspace/child" }),
        })
        expect(yield* service.current({ sessionID: "one", location, enabled: false })).toBe("/workspace")
        expect(yield* service.current({ sessionID: "one", location, enabled: true })).toBe("/workspace")
      }),
    ))

  test("does not reuse state across a Location identity change", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        yield* service.execute({
          sessionID: "one",
          location,
          command: "cd child",
          environment: {},
          enabled: true,
          provider: provider({ finalCwd: "/workspace/child" }),
        })
        expect(
          yield* service.current({
            sessionID: "one",
            location: { target: "local", directory: "/other" },
            enabled: true,
          }),
        ).toBe("/other")
      }),
    ))

  test("Location rebind resets cwd and invalidates completion generation", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        const locationRuntime = yield* SessionLocationRuntime.Service
        yield* service.execute({
          sessionID: "ses_one",
          location,
          command: "cd child",
          environment: {},
          enabled: true,
          provider: provider({ finalCwd: "/workspace/child" }),
        })
        const before = yield* service.complete({
          sessionID: "ses_one",
          location,
          input: "x",
          cursor: 1,
          environment: {},
          enabled: true,
          provider: provider(),
        })
        yield* locationRuntime.rebound(SessionSchema.ID.make("ses_one"))
        expect(yield* service.current({ sessionID: "ses_one", location, enabled: true })).toBe("/workspace")
        const after = yield* service.complete({
          sessionID: "ses_one",
          location,
          input: "x",
          cursor: 1,
          environment: {},
          enabled: true,
          provider: provider(),
        })
        expect(after.generation).toBeGreaterThan(before.generation)
      }),
    ))

  test("discards a completion result from an older cwd generation", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        const gate = yield* Deferred.make<void>()
        const slow: Provider = {
          ...provider(),
          complete: () =>
            Deferred.await(gate).pipe(
              Effect.as({
                candidates: [{ value: "old", display: "old", replacement: { start: 0, end: 1 }, kind: "file" }],
              }),
            ),
        }
        const completion = yield* service
          .complete({
            sessionID: "one",
            location,
            input: "o",
            cursor: 1,
            environment: {},
            enabled: true,
            provider: slow,
          })
          .pipe(Effect.forkChild)
        yield* Effect.yieldNow
        yield* service.execute({
          sessionID: "one",
          location,
          command: "cd child",
          environment: {},
          enabled: true,
          provider: provider({ finalCwd: "/workspace/child" }),
        })
        yield* Deferred.succeed(gate, undefined)
        expect(yield* Fiber.join(completion)).toMatchObject({ stale: true, candidates: [] })
      }),
    ))

  test("reports execution as a User Shell rebind blocker", async () => {
    const gate = Deferred.makeUnsafe<void>()
    const started = Deferred.makeUnsafe<void>()
    const blocking: Provider = {
      ...provider(),
      execute: () =>
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Deferred.await(gate)), Effect.as({ exitCode: 0 })),
    }
    await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        const activity = yield* SessionActivity.Service
        const execution = yield* service
          .execute({
            sessionID: "ses_one",
            location,
            command: "wait",
            environment: {},
            enabled: true,
            provider: blocking,
          })
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        expect(yield* activity.blockers(SessionSchema.ID.make("ses_one"))).toEqual(["user_shell"])
        yield* Deferred.succeed(gate, undefined)
        yield* Fiber.join(execution)
        expect(yield* activity.blockers(SessionSchema.ID.make("ses_one"))).toEqual([])
      }).pipe(Effect.provide(runtimeLayer), Effect.scoped),
    )
  })

  test("bounds one-shot execution, interrupts the provider, and preserves cwd", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        let interrupted = false
        const blocking: Provider = {
          ...provider(),
          execute: () => Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => (interrupted = true)))),
        }
        const execution = yield* service
          .execute({
            sessionID: "one",
            location,
            command: "interactive-command",
            environment: {},
            enabled: true,
            provider: blocking,
          })
          .pipe(Effect.forkChild)
        yield* TestClock.adjust(UserShellRuntime.EXECUTION_TIMEOUT)
        expect(yield* Fiber.join(execution)).toEqual({ exitCode: 124, timedOut: true })
        expect(interrupted).toBe(true)
        expect(yield* service.current({ sessionID: "one", location, enabled: true })).toBe("/workspace")
      }),
    ))
})
