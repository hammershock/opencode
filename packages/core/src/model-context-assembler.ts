export * as ModelContextAssembler from "./model-context-assembler"

import { Context, Effect, Layer } from "effect"
import type { AgentV2 } from "./agent"
import { makeLocationNode } from "./effect/app-node"
import { ReferenceGuidance } from "./reference/guidance"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"

export interface Interface {
  /** Assemble every core-owned model-context source for the bound Location. */
  readonly load: (agent?: AgentV2.ID | string) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelContextAssembler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const references = yield* ReferenceGuidance.Service

    return Service.of({
      load: Effect.fn("ModelContextAssembler.load")(function* () {
        return SystemContext.combine(
          yield* Effect.all([registry.load(), references.load()], {
            concurrency: "unbounded",
          }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SystemContextRegistry.node, ReferenceGuidance.node],
})
