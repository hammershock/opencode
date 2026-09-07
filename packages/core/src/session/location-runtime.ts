export * as SessionLocationRuntime from "./location-runtime"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { SessionSchema } from "./schema"

export interface Interface {
  readonly register: (handler: (sessionID: SessionSchema.ID) => Effect.Effect<void>) => Effect.Effect<void>
  readonly rebound: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLocationRuntime") {}

export const layer = Layer.sync(Service, () => {
  const handlers = new Set<(sessionID: SessionSchema.ID) => Effect.Effect<void>>()
  return Service.of({
    register: (handler) => Effect.sync(() => handlers.add(handler)).pipe(Effect.asVoid),
    rebound: (sessionID) => Effect.forEach(handlers, (handler) => handler(sessionID), { discard: true }),
  })
})

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
