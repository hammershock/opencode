export * as SkillResolver from "./resolver"

import { Skill } from "@opencode-ai/schema/skill"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { SkillV2 } from "../skill"
import { SkillRegistry } from "./registry"

export interface Resolved {
  readonly entry: SkillRegistry.Entry
}

export interface Interface {
  readonly resolveName: (input: { readonly agent: AgentV2.ID; readonly name: string }) => Effect.Effect<Resolved, Error>
  readonly read: (resolved: Resolved) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillResolver") {}

export class Error extends Schema.TaggedErrorClass<Error>()("SkillResolver.Error", {
  kind: Schema.Literals(["resource_unavailable_on_device", "skill_inapplicable", "ambiguous_skill"]),
}) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const registry = yield* SkillRegistry.Service
    const skills = yield* SkillV2.Service

    const permitted = Effect.fnUntraced(function* (agent: AgentV2.ID, entries: ReadonlyArray<SkillRegistry.Entry>) {
      const selected = yield* agents.select(agent)
      const info = selected.info
      if (!info) return []
      return entries.filter((entry) => SkillV2.available([entry.metadata], info).length > 0)
    })

    return Service.of({
      resolveName: Effect.fn("SkillResolver.resolveName")(function* (input) {
        const entries = (yield* permitted(input.agent, (yield* skills.catalog()).entries)).filter(
          (entry) => entry.metadata.name === input.name,
        )
        if (entries.length === 0) return yield* new Error({ kind: "resource_unavailable_on_device" })
        if (entries.length > 1) return yield* new Error({ kind: "ambiguous_skill" })
        return { entry: entries[0]! }
      }),
      read: Effect.fn("SkillResolver.read")(function* (resolved) {
        const entry = yield* registry
          .read(resolved.entry)
          .pipe(Effect.mapError(() => new Error({ kind: "resource_unavailable_on_device" })))
        return { entry }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentV2.node, SkillV2.node, SkillRegistry.node],
})
