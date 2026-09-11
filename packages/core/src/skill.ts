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

export function preview(snapshot: Skill.RegistrySnapshot, agent: AgentV2.Info | undefined) {
  const skills = agent ? available(snapshot.skills, agent) : []
  const digest = Skill.Digest.make(Hash.sha256(JSON.stringify({ skills, diagnostics: snapshot.diagnostics })))
  return Skill.RegistrySnapshot.make({
    revision: snapshot.revision,
    skills,
    diagnostics: snapshot.diagnostics,
    digest,
  })
}

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
  readonly catalog: (options?: CatalogOptions) => Effect.Effect<SkillRegistry.Result>
  readonly lookup: (id: Skill.ID) => Effect.Effect<Lookup>
}

export interface CatalogOptions extends SkillRegistry.LoadOptions {
  readonly includeInactive?: boolean
}

export type Lookup =
  | { readonly status: "missing" }
  | { readonly status: "target-inapplicable"; readonly entry: SkillRegistry.Entry }
  | { readonly status: "available"; readonly entry: SkillRegistry.Entry }

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

    const result = Effect.fn("SkillV2.registry")(function* (options?: CatalogOptions) {
      const loaded = yield* registry.load(state.get().registrations, options)
      const configured = yield* Effect.promise(() => settings.load())
      const target = state.get().target
      const entries = options?.includeInactive
        ? loaded.entries
        : loaded.entries.filter((entry) => {
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
      const digest = Skill.Digest.make(
        Hash.sha256(JSON.stringify({ skills, diagnostics, target: options?.includeInactive ? "*" : target })),
      )
      return {
        entries,
        snapshot: Skill.RegistrySnapshot.make({ revision: digest, skills, diagnostics, digest }),
      }
    })

    const list = Effect.fn("SkillV2.list")(function* () {
      const priority = new Map(
        state.get().registrations.map((registration, index) => [SkillRegistry.key(registration), index]),
      )
      const entries = (yield* result()).entries.toSorted(
        (a, b) =>
          (priority.get(a.sourceKey) ?? 0) - (priority.get(b.sourceKey) ?? 0) ||
          a.metadata.id.localeCompare(b.metadata.id),
      )
      return entries
        .map((entry) => ({
          name: entry.metadata.name,
          ...(entry.metadata.description === undefined ? {} : { description: entry.metadata.description }),
          ...(entry.slash === undefined ? {} : { slash: entry.slash }),
          location: entry.location,
          content: entry.content,
        }))
        .toSorted((a, b) => a.name.localeCompare(b.name) || a.location.localeCompare(b.location))
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      sources: Effect.fn("SkillV2.sources")(function* () {
        return state.get().registrations.map((item) => item.source)
      }),
      list,
      catalog: result,
      lookup: Effect.fn("SkillV2.lookup")(function* (id) {
        const loaded = yield* registry.load(state.get().registrations)
        const entry = loaded.entries.find((item) => item.metadata.id === id)
        if (!entry) return { status: "missing" as const }
        const configured = yield* Effect.promise(() => settings.load())
        const scope = configured.targets[id] ?? "*"
        if (scope === "*" || scope.includes(state.get().target)) return { status: "available" as const, entry }
        return { status: "target-inapplicable" as const, entry }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [SkillRegistry.node, SkillSettings.node],
})
