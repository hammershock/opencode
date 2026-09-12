export * as SkillResolver from "./resolver"

import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { Database } from "../database/database"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { SessionSkillCatalog } from "../session/skill-catalog"
import { SkillV2 } from "../skill"
import { SkillRegistry } from "./registry"

export interface Resolved {
  readonly entry: SkillRegistry.Entry
}

export interface Interface {
  readonly resolveName: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: AgentV2.ID
    readonly name: string
  }) => Effect.Effect<Resolved, Error>
  readonly read: (resolved: Resolved) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillResolver") {}

export class Error extends Schema.TaggedErrorClass<Error>()("SkillResolver.Error", {
  kind: Schema.Literals(["not_admitted", "resource_unavailable_on_device", "skill_inapplicable", "ambiguous_skill"]),
}) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const database = yield* Database.Service
    const registry = yield* SkillRegistry.Service
    const skills = yield* SkillV2.Service

    return Service.of({
      resolveName: Effect.fn("SkillResolver.resolveName")(function* (input) {
        const admitted = (yield* SessionSkillCatalog.get(database.db, input.sessionID))?.skills.filter(
          (skill) => skill.name === input.name,
        )
        if (!admitted?.length) return yield* new Error({ kind: "not_admitted" })
        if (admitted.length > 1) return yield* new Error({ kind: "ambiguous_skill" })
        const match = yield* skills.lookup(admitted[0].id)
        if (match.status === "missing" || match.entry.metadata.name !== input.name)
          return yield* new Error({ kind: "resource_unavailable_on_device" })
        if (match.status === "target-inapplicable") return yield* new Error({ kind: "skill_inapplicable" })
        const agent = (yield* agents.select(input.agent)).info
        if (!agent || SkillV2.available([match.entry.metadata], agent).length === 0)
          return yield* new Error({ kind: "skill_inapplicable" })
        return { entry: match.entry }
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
  deps: [AgentV2.node, Database.node, SkillV2.node, SkillRegistry.node],
})
