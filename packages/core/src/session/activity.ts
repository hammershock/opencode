export * as SessionActivity from "./activity"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export type Kind = "process_execution" | "user_shell" | "session_mutation" | "sync_replay"

export interface Interface {
  readonly blockers: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Kind>>
  readonly withActivity: <A, E, R>(
    sessionID: SessionSchema.ID,
    kind: Kind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionActivity") {}

const counts = new Map<string, Map<Kind, number>>()

export const layer = Layer.sync(Service, () => {
  const change = (sessionID: SessionSchema.ID, kind: Kind, delta: 1 | -1) => {
    const current = counts.get(sessionID) ?? new Map<Kind, number>()
    const next = (current.get(kind) ?? 0) + delta
    if (next > 0) current.set(kind, next)
    else current.delete(kind)
    if (current.size) counts.set(sessionID, current)
    else counts.delete(sessionID)
  }
  return Service.of({
    blockers: (sessionID) => Effect.sync(() => [...(counts.get(sessionID)?.keys() ?? [])]),
    withActivity: (sessionID, kind, effect) =>
      Effect.acquireUseRelease(
        Effect.sync(() => change(sessionID, kind, 1)),
        () => effect,
        () => Effect.sync(() => change(sessionID, kind, -1)),
      ),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
