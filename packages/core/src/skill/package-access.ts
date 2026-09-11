export * as SkillPackageAccess from "./package-access"

import path from "path"
import { Skill } from "@opencode-ai/schema/skill"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { SessionSchema } from "../session/schema"
import { AbsolutePath } from "../schema"
import { SkillRegistry } from "./registry"

export interface Prepared {
  readonly path?: AbsolutePath
  readonly temporary: boolean
}

export interface Interface {
  readonly prepare: (input: {
    readonly entry: SkillRegistry.Entry
    readonly sessionID: SessionSchema.ID
    readonly signal?: AbortSignal
  }) => Effect.Effect<Prepared, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillPackageAccess") {}

export class Failure extends Schema.TaggedErrorClass<Failure>()("SkillPackageAccess.Failure", {
  skillID: Skill.ID,
  kind: Schema.Literals(["unavailable"]),
}) {}

const layer = Layer.succeed(
  Service,
  Service.of({
    prepare: Effect.fn("SkillPackageAccess.prepare")(function* (input) {
      if (input.entry.source.kind === "built-in") return { temporary: false }
      return {
        path: AbsolutePath.make(path.dirname(input.entry.location)),
        temporary: false,
      }
    }),
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
