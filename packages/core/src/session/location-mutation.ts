export * as SessionLocationMutation from "./location-mutation"

import { Context, Effect, Layer, Semaphore } from "effect"
import { makeGlobalNode } from "../effect/app-node"

export interface Interface {
  readonly withLock: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLocationMutation") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1)
    return Service.of({ withLock: (effect) => semaphore.withPermits(1)(effect) })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
