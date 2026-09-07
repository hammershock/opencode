export * as SessionActivity from "./activity"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { KeyedMutex } from "../effect/keyed-mutex"
import { SessionSchema } from "./schema"

export type Kind = "process_execution" | "user_shell" | "session_mutation" | "sync_replay"

export interface Interface {
  readonly blockers: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<Kind>>
  readonly withActivity: <A, E, R>(
    sessionID: SessionSchema.ID,
    kind: Kind,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
  /**
   * Prevents new activities from being admitted for the exact Session set while
   * a Location mutation performs its final blocker check and commit.
   */
  readonly withExclusive: <A, E, R>(
    sessionIDs: ReadonlyArray<SessionSchema.ID>,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionActivity") {}

export const layer = Layer.sync(Service, () => {
  const counts = new Map<string, Map<Kind, number>>()
  const gates = KeyedMutex.makeUnsafe<SessionSchema.ID>()
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
        gates.withLock(sessionID)(Effect.sync(() => change(sessionID, kind, 1))),
        () => effect,
        () => gates.withLock(sessionID)(Effect.sync(() => change(sessionID, kind, -1))),
      ),
    withExclusive: (sessionIDs, effect) => {
      const ordered = [...new Set(sessionIDs)].sort()
      return ordered.reduceRight<Effect.Effect<any, any, any>>(
        (current, sessionID) => gates.withLock(sessionID)(current),
        effect,
      )
    },
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
