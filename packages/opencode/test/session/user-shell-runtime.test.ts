import { describe, expect, test } from "bun:test"
import { Deferred, Effect, Fiber } from "effect"
import { UserShellRuntime, type Provider } from "@/session/user-shell-runtime"

const location = { target: "local", directory: "/workspace" }

function provider(input?: { finalCwd?: string; valid?: boolean }): Provider {
  return {
    execute: () => Effect.succeed({ exitCode: 0, finalCwd: input?.finalCwd }),
    validateDirectory: (directory) => Effect.succeed(input?.valid === false ? undefined : directory),
    complete: () => Effect.succeed([]),
  }
}

function runtime<A, E>(effect: Effect.Effect<A, E, UserShellRuntime.Service>) {
  return Effect.runPromise(effect.pipe(Effect.provide(UserShellRuntime.layer)))
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

  test("discards a completion result from an older cwd generation", () =>
    runtime(
      Effect.gen(function* () {
        const service = yield* UserShellRuntime.Service
        const gate = yield* Deferred.make<void>()
        const slow: Provider = {
          ...provider(),
          complete: () =>
            Deferred.await(gate).pipe(
              Effect.as([{ value: "old", display: "old", replacement: { start: 0, end: 1 }, kind: "file" }]),
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
})
