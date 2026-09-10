export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { PermissionV2 } from "./permission"
import { SkillRegistry } from "./skill/registry"
import { State } from "./state"

export const DirectorySource = Skill.DirectorySource
export type DirectorySource = Skill.DirectorySource

export const UrlSource = Skill.UrlSource
export type UrlSource = Skill.UrlSource

export const EmbeddedSource = Skill.EmbeddedSource
export type EmbeddedSource = Skill.EmbeddedSource

export const Source = Skill.Source
export type Source = typeof Source.Type

export const Info = Skill.Info
export type Info = Skill.Info

export const available = (skills: ReadonlyArray<Info>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

export type Data = {
  registrations: Types.DeepMutable<SkillRegistry.Registration>[]
}

export type Draft = {
  source: (source: Source, options?: SkillRegistry.SourceOptions) => void
  list: () => readonly Source[]
}

export interface Interface extends State.Transformable<Draft> {
  readonly sources: () => Effect.Effect<Source[]>
  readonly list: () => Effect.Effect<Info[]>
  readonly catalog: (options?: SkillRegistry.LoadOptions) => Effect.Effect<SkillRegistry.Result>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Skill") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const registry = yield* SkillRegistry.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ registrations: [] }),
      draft: (draft) => ({
        source: (source, options) => {
          const registration = { source, options }
          if (draft.registrations.some((item) => SkillRegistry.key(item) === SkillRegistry.key(registration))) return
          draft.registrations.push(registration as Types.DeepMutable<SkillRegistry.Registration>)
        },
        list: () => draft.registrations.map((item) => item.source) as Source[],
      }),
    })

    const result = Effect.fn("SkillV2.registry")(function* (options?: SkillRegistry.LoadOptions) {
      return yield* registry.load(state.get().registrations, options)
    })

    const list = Effect.fn("SkillV2.list")(function* () {
      const skills = new Map<string, Info>()
      const priority = new Map(
        state.get().registrations.map((registration, index) => [SkillRegistry.key(registration), index]),
      )
      const entries = (yield* result()).entries.toSorted(
        (a, b) =>
          (priority.get(a.sourceKey) ?? 0) - (priority.get(b.sourceKey) ?? 0) ||
          a.metadata.id.localeCompare(b.metadata.id),
      )
      for (const entry of entries) {
        skills.set(entry.metadata.name, {
          name: entry.metadata.name,
          ...(entry.metadata.description === undefined ? {} : { description: entry.metadata.description }),
          ...(entry.slash === undefined ? {} : { slash: entry.slash }),
          location: entry.location,
          content: entry.content,
        })
      }
      return Array.from(skills.values()).toSorted((a, b) => a.name.localeCompare(b.name))
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().registrations.map((item) => item.source)
      }),
      list,
      catalog: result,
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [SkillRegistry.node] })
