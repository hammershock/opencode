import { Cause, Context, Duration, Effect, Layer } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import type { SessionSchema } from "@opencode-ai/core/session/schema"

export * as UserShellRuntime from "./user-shell-runtime"

export type LocationIdentity = {
  readonly target: string
  readonly directory: string
}

export type Environment = Readonly<Record<string, string>>

export type ExecuteResult = {
  readonly exitCode: number
  readonly finalCwd?: string
  readonly timedOut?: true
}

export const EXECUTION_TIMEOUT = Duration.minutes(10)
export const TIMEOUT_GUIDANCE = "Command timed out. Use Terminal panel for interactive commands."

export type CompletionKind = "command" | "file" | "directory" | "alias" | "function" | "option" | "argument"

export type CompletionCandidate = {
  readonly value: string
  readonly display: string
  readonly replacement: { readonly start: number; readonly end: number }
  readonly kind: CompletionKind
  readonly description?: string
}

export type CompletionResult = {
  readonly generation: number
  readonly stale: boolean
  readonly candidates: ReadonlyArray<CompletionCandidate>
}

export interface Provider {
  readonly execute: (input: {
    readonly cwd: string
    readonly command: string
    readonly environment: Environment
    readonly signal?: AbortSignal
    readonly onOutput?: (chunk: string) => Effect.Effect<void>
  }) => Effect.Effect<ExecuteResult, unknown>
  readonly validateDirectory: (directory: string) => Effect.Effect<string | undefined, unknown>
  readonly complete: (input: {
    readonly cwd: string
    readonly input: string
    readonly cursor: number
    readonly environment: Environment
    readonly signal?: AbortSignal
  }) => Effect.Effect<ReadonlyArray<CompletionCandidate>, unknown>
}

export interface Interface {
  readonly current: (input: {
    readonly sessionID: string
    readonly location: LocationIdentity
    readonly enabled: boolean
  }) => Effect.Effect<string>
  readonly execute: (input: {
    readonly sessionID: string
    readonly location: LocationIdentity
    readonly command: string
    readonly environment: Environment
    readonly enabled: boolean
    readonly provider: Provider
    readonly signal?: AbortSignal
    readonly onOutput?: (chunk: string) => Effect.Effect<void>
  }) => Effect.Effect<ExecuteResult, unknown>
  readonly complete: (input: {
    readonly sessionID: string
    readonly location: LocationIdentity
    readonly input: string
    readonly cursor: number
    readonly environment: Environment
    readonly enabled: boolean
    readonly provider: Provider
    readonly signal?: AbortSignal
  }) => Effect.Effect<CompletionResult, unknown>
  readonly reset: (sessionID: string) => Effect.Effect<void>
  readonly disable: Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/UserShellRuntime") {}

type State = {
  readonly identity: string
  readonly cwd: string
  readonly generation: number
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const activity = yield* SessionActivity.Service
    const states = new Map<string, State>()
    let generation = 0

    const identity = (location: LocationIdentity) => JSON.stringify([location.target, location.directory])

    const state = (input: { sessionID: string; location: LocationIdentity; enabled: boolean }) => {
      if (!input.enabled) {
        if (states.delete(input.sessionID)) generation++
        return { identity: identity(input.location), cwd: input.location.directory, generation }
      }
      const found = states.get(input.sessionID)
      if (found?.identity === identity(input.location)) return found
      const next = { identity: identity(input.location), cwd: input.location.directory, generation: ++generation }
      states.set(input.sessionID, next)
      return next
    }

    const current = Effect.fn("UserShellRuntime.current")(function* (input: {
      sessionID: string
      location: LocationIdentity
      enabled: boolean
    }) {
      return state(input).cwd
    })

    const execute = Effect.fn("UserShellRuntime.execute")(
      (input: {
        sessionID: string
        location: LocationIdentity
        command: string
        environment: Environment
        enabled: boolean
        provider: Provider
        signal?: AbortSignal
        onOutput?: (chunk: string) => Effect.Effect<void>
      }) =>
        activity.withActivity(
          input.sessionID as SessionSchema.ID,
          "user_shell",
          Effect.gen(function* () {
            const before = state(input)
            const result = yield* input.provider
              .execute({
                cwd: before.cwd,
                command: input.command,
                environment: input.environment,
                signal: input.signal,
                onOutput: input.onOutput,
              })
              .pipe(
                Effect.timeout(EXECUTION_TIMEOUT),
                Effect.catch((error) =>
                  Cause.isTimeoutError(error)
                    ? Effect.succeed<ExecuteResult>({ exitCode: 124, timedOut: true })
                    : Effect.fail(error),
                ),
              )
            if (!input.enabled || !result.finalCwd) return result
            const canonical = yield* input.provider.validateDirectory(result.finalCwd)
            const latest = states.get(input.sessionID)
            if (!canonical || latest?.generation !== before.generation || latest.identity !== before.identity)
              return result
            states.set(input.sessionID, { ...latest, cwd: canonical, generation: ++generation })
            return result
          }),
        ),
    )

    const complete = Effect.fn("UserShellRuntime.complete")(
      (input: {
        sessionID: string
        location: LocationIdentity
        input: string
        cursor: number
        environment: Environment
        enabled: boolean
        provider: Provider
        signal?: AbortSignal
      }) =>
        activity.withActivity(
          input.sessionID as SessionSchema.ID,
          "user_shell",
          Effect.gen(function* () {
            const before = state(input)
            const candidates = yield* input.provider.complete({
              cwd: before.cwd,
              input: input.input,
              cursor: input.cursor,
              environment: input.environment,
              signal: input.signal,
            })
            const latest = input.enabled ? states.get(input.sessionID) : undefined
            const stale =
              input.enabled && (latest?.generation !== before.generation || latest.identity !== before.identity)
            return {
              generation: before.generation,
              stale,
              candidates: stale ? [] : candidates,
            }
          }),
        ),
    )

    const reset = Effect.fn("UserShellRuntime.reset")(function* (sessionID: string) {
      if (states.delete(sessionID)) generation++
    })

    const disable = Effect.sync(() => {
      if (states.size === 0) return
      states.clear()
      generation++
    })

    return Service.of({ current, execute, complete, reset, disable })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [SessionActivity.node] })
