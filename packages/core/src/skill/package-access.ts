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

export const toModelContent = (input: {
  readonly name: string
  readonly content: string
  readonly prepared?: Prepared
}) =>
  [
    `# Skill: ${input.name}`,
    "",
    input.content.trim(),
    "",
    ...(input.prepared?.path === undefined
      ? ["This Skill has no filesystem package directory."]
      : input.prepared.temporary
        ? [
            `Temporary package directory on this execution target: ${input.prepared.path}`,
            "This is a shared, mutable runtime copy and can be reclaimed when the Session disconnects or expires.",
            "Before starting persistent background work, copy every required file into a persistent target directory.",
            "Use the ordinary filesystem and shell tools to read, modify, or execute files in this directory.",
          ]
        : [
            `Package directory: ${input.prepared.path}`,
            "Relative paths in this Skill are relative to this directory.",
            "Use the ordinary filesystem and shell tools to read, modify, or execute files in this directory.",
          ]),
  ].join("\n")

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
