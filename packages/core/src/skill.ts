export * as SkillV2 from "./skill"

import { makeLocationNode } from "./effect/app-node"
import { Context, Effect, Layer, Types } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "./agent"
import { PermissionV2 } from "./permission"
import { SkillRegistry } from "./skill/registry"
import { State } from "./state"
import { SkillSettings } from "./skill/settings"
import { Hash } from "./util/hash"

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

export const available = <A extends { readonly name: string }>(skills: ReadonlyArray<A>, agent: AgentV2.Info) =>
  skills.filter((skill) => PermissionV2.evaluate("skill", skill.name, agent.permissions).effect !== "deny")

export type Data = {
  registrations: Types.DeepMutable<SkillRegistry.Registration>[]
  diagnostics: Types.DeepMutable<Skill.Diagnostic>[]
  target: Skill.Target
}

export type Draft = {
  source: (source: Source, options?: SkillRegistry.SourceOptions) => void
  diagnostic: (diagnostic: Skill.Diagnostic) => void
  target: (target: Skill.Target) => void
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
    const settings = yield* SkillSettings.Service

    const state = State.create<Data, Draft>({
      initial: () => ({ registrations: [], diagnostics: [], target: "local" }),
      draft: (draft) => ({
        source: (source, options) => {
          const registration = { source, options }
          if (draft.registrations.some((item) => SkillRegistry.key(item) === SkillRegistry.key(registration))) return
          draft.registrations.push(registration as Types.DeepMutable<SkillRegistry.Registration>)
        },
        diagnostic: (diagnostic) => {
          draft.diagnostics.push(diagnostic as Types.DeepMutable<Skill.Diagnostic>)
        },
        target: (target) => {
          draft.target = target
        },
        list: () => draft.registrations.map((item) => item.source) as Source[],
      }),
    })

    const result = Effect.fn("SkillV2.registry")(function* (options?: SkillRegistry.LoadOptions) {
      const loaded = yield* registry.load(state.get().registrations, options)
      const configured = yield* Effect.promise(() => settings.load())
      const target = state.get().target
      const entries = loaded.entries.filter((entry) => {
        const scope = configured.targets[entry.metadata.id] ?? "*"
        return scope === "*" || scope.includes(target)
      })
      const diagnostics = [
        ...loaded.snapshot.diagnostics,
        ...state.get().diagnostics,
        ...configured.diagnostics.map((diagnostic) =>
          Skill.Diagnostic.make({
            kind: diagnostic.kind === "missing-target" ? "missing-target" : "invalid-settings",
            severity: diagnostic.severity,
            sourceLabel: "Skill settings",
            message: diagnostic.message,
            ...(diagnostic.skillID === undefined ? {} : { skillID: diagnostic.skillID }),
          }),
        ),
      ].toSorted(
        (a, b) =>
          a.sourceLabel.localeCompare(b.sourceLabel) ||
          a.kind.localeCompare(b.kind) ||
          a.message.localeCompare(b.message),
      )
      const skills = entries.map((entry) => entry.metadata)
      const digest = Skill.Digest.make(Hash.sha256(JSON.stringify({ skills, diagnostics, target })))
      return {
        entries,
        snapshot: Skill.RegistrySnapshot.make({ revision: digest, skills, diagnostics, digest }),
      }
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

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillRegistry.node, SkillSettings.node],
})
