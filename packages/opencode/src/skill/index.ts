import path from "path"
import type { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { Context, Effect, Layer, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { escapeHtml } from "@/util/html"

export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  location: Schema.String,
  content: Schema.String,
})
export type Info = Schema.Schema.Type<typeof Info>

const Issue = Schema.StructWithRest(
  Schema.Struct({
    message: Schema.String,
    path: Schema.Array(Schema.String),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)],
)

export class InvalidError extends Schema.TaggedErrorClass<InvalidError>()("SkillInvalidError", {
  path: Schema.String,
  message: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Issue)),
}) {}

export class NameMismatchError extends Schema.TaggedErrorClass<NameMismatchError>()("SkillNameMismatchError", {
  path: Schema.String,
  expected: Schema.String,
  actual: Schema.String,
}) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Skill.NotFoundError", {
  name: Schema.String,
  available: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" not found. Available skills: ${this.available.join(", ") || "none"}`
  }
}

export class AmbiguousError extends Schema.TaggedErrorClass<AmbiguousError>()("Skill.AmbiguousError", {
  name: Schema.String,
  sources: Schema.Array(Schema.String),
}) {
  override get message() {
    return `Skill "${this.name}" is ambiguous. Choose one of: ${this.sources.join(", ")}`
  }
}

export interface Interface {
  readonly get: (name: string) => Effect.Effect<Info | undefined>
  readonly require: (name: string) => Effect.Effect<Info, NotFoundError | AmbiguousError>
  readonly all: () => Effect.Effect<Info[]>
  readonly dirs: () => Effect.Effect<string[]>
  readonly available: (agent?: Agent.Info) => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service

    const catalog = Effect.fn("Skill.compatibilityCatalog")(function* () {
      const context = yield* InstanceState.context
      const workspaceID = yield* InstanceState.workspaceID
      return yield* Effect.gen(function* () {
        const plugin = yield* PluginV2.Service
        yield* plugin.wait(PluginV2.INTERNAL_READY_ID)
        return yield* (yield* SkillV2.Service).catalog()
      }).pipe(
        Effect.provide(
          locations.get(
            Location.Ref.make({
              directory: AbsolutePath.make(context.directory),
              ...(workspaceID === undefined ? {} : { workspaceID }),
            }),
          ),
        ),
      )
    })

    const all = Effect.fn("Skill.all")(function* () {
      return (yield* catalog()).entries.map(toInfo)
    })

    const matches = Effect.fnUntraced(function* (name: string) {
      return (yield* catalog()).entries.filter((entry) => entry.metadata.name === name)
    })

    return Service.of({
      get: Effect.fn("Skill.get")(function* (name) {
        const found = yield* matches(name)
        return found.length === 1 ? toInfo(found[0]!) : undefined
      }),
      require: Effect.fn("Skill.require")(function* (name) {
        const found = yield* matches(name)
        if (found.length === 1) return toInfo(found[0]!)
        const list = yield* all()
        if (found.length === 0)
          return yield* new NotFoundError({ name, available: list.map((item) => item.name).toSorted() })
        return yield* new AmbiguousError({
          name,
          sources: found.map((entry) => entry.metadata.sourceLabel).toSorted(),
        })
      }),
      all,
      dirs: Effect.fn("Skill.dirs")(function* () {
        return Array.from(
          new Set(
            (yield* catalog()).entries
              .filter((entry) => entry.source.kind !== "built-in")
              .map((entry) => path.dirname(entry.location)),
          ),
        ).toSorted()
      }),
      available: Effect.fn("Skill.available")(function* (agent) {
        const list = yield* all()
        if (!agent) return list
        return list.filter((skill) => Permission.evaluate("skill", skill.name, agent.permission).action !== "deny")
      }),
    })
  }),
)

function toInfo(entry: SkillRegistry.Entry): Info {
  return {
    name: entry.metadata.name,
    ...(entry.metadata.description === undefined ? {} : { description: entry.metadata.description }),
    location: entry.location,
    content: entry.content,
  }
}

export function fmt(list: Info[], opts: { verbose: boolean }) {
  const described = list.filter((skill) => skill.description !== undefined)
  if (described.length === 0) return "No skills are currently available."
  if (opts.verbose) {
    return [
      "<available_skills>",
      ...described
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .flatMap((skill) => [
          "  <skill>",
          `    <name>${skill.name}</name>`,
          `    <description>${skill.description}</description>`,
          `    <location>${escapeHtml(skill.location)}</location>`,
          "  </skill>",
        ]),
      "</available_skills>",
    ].join("\n")
  }

  return [
    "## Available Skills",
    ...described
      .toSorted((a, b) => a.name.localeCompare(b.name))
      .map((skill) => `- **${skill.name}**: ${skill.description}`),
  ].join("\n")
}

export const node = LayerNode.make({
  service: Service,
  layer,
  deps: [LocationServiceMap.node],
})

export * as Skill from "."
