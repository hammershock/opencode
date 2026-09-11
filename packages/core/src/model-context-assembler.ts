export * as ModelContextAssembler from "./model-context-assembler"

import { Context, Effect, Layer } from "effect"
import { AgentV2 } from "./agent"
import { makeLocationNode } from "./effect/app-node"
import { ReferenceGuidance } from "./reference/guidance"
import { SkillGuidance } from "./skill/guidance"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import type { Skill } from "@opencode-ai/schema/skill"

export interface Interface {
  /** Assemble every core-owned model-context source for the bound Location. */
  readonly load: (
    agent?: AgentV2.ID | string,
    options?: { readonly skillCatalog?: Skill.RegistrySnapshot; readonly preserveSkillCatalog?: boolean },
  ) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ModelContextAssembler") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* SystemContextRegistry.Service
    const agents = yield* AgentV2.Service
    const skills = yield* SkillGuidance.Service
    const references = yield* ReferenceGuidance.Service

    return Service.of({
      load: Effect.fn("ModelContextAssembler.load")(function* (agent, options) {
        const selection = yield* agents.select(agent)
        return SystemContext.combine(
          yield* Effect.all(
            [
              registry.load(),
              skills.load(selection, options?.skillCatalog, options?.preserveSkillCatalog),
              references.load(),
            ],
            {
              concurrency: "unbounded",
            },
          ),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SystemContextRegistry.node, AgentV2.node, SkillGuidance.node, ReferenceGuidance.node],
})
