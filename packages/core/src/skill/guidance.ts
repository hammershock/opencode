export * as SkillGuidance from "./guidance"

import { makeLocationNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "../agent"
import { PermissionV2 } from "../permission"
import { SkillV2 } from "../skill"
import { SystemContext } from "../system-context/index"
import { SkillGuidanceSnapshot } from "./guidance-snapshot"

const render = (catalog: SkillGuidanceSnapshot.Catalog) =>
  catalog.enabled
    ? [
        "Skills provide specialized instructions and workflows for specific tasks.",
        "Use the skill tool to load a skill when a task matches its description.",
        ...(catalog.skills.length === 0 && !catalog.omitted
          ? ["No skills are currently available."]
          : [
              "<available_skills>",
              ...catalog.skills.flatMap((skill) => [
                "  <skill>",
                `    <name>${skill.name}</name>`,
                ...(skill.description === undefined ? [] : [`    <description>${skill.description}</description>`]),
                `    <source>${skill.sourceLabel}</source>`,
                "  </skill>",
              ]),
              ...(catalog.omitted
                ? [
                    `  <omitted count="${catalog.omitted}">Additional skills remain available through explicit selection.</omitted>`,
                  ]
                : []),
              "</available_skills>",
            ]),
      ].join("\n")
    : ""

export interface Interface {
  readonly load: (
    agent: AgentV2.Selection,
    snapshot?: Skill.RegistrySnapshot,
    preservePrevious?: boolean,
  ) => Effect.Effect<SystemContext.SystemContext>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/SkillGuidance") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const skills = yield* SkillV2.Service

    return Service.of({
      load: Effect.fn("SkillGuidance.load")(function* (selection, snapshot, preservePrevious) {
        const load = snapshot
          ? Effect.succeed(snapshot)
          : skills.catalog().pipe(Effect.map((result) => result.snapshot))
        return SystemContext.make({
          key: SystemContext.Key.make("core/skill-guidance"),
          refresh: "activation",
          allowEmpty: true,
          codec: Schema.toCodecJson(SkillGuidanceSnapshot.Catalog),
          load: load.pipe(Effect.map((current) => catalog(current, selection.info))),
          baseline: render,
          update: (_previous, current) =>
            current.enabled
              ? [
                  "The available skills have changed. This list supersedes the previous available skills list.",
                  render(current),
                ].join("\n")
              : "Skill guidance is no longer available. Do not use any previously listed skill.",
          preservePrevious: () => preservePrevious ?? false,
        })
      }),
    })
  }),
)

export const locationLayer = layer

export const node = makeLocationNode({ service: Service, layer, deps: [SkillV2.node] })

function catalog(snapshot: Skill.RegistrySnapshot, agent: AgentV2.Info | undefined) {
  const skills = agent ? SkillV2.available(snapshot.skills, agent) : []
  const enabled =
    agent !== undefined &&
    !(skills.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny")
  const diagnostics = snapshot.diagnostics
    .map((diagnostic) =>
      SkillGuidanceSnapshot.Diagnostic.make({
        kind: diagnostic.kind,
        severity: diagnostic.severity,
        sourceLabel: SkillGuidanceSnapshot.sourceLabel(diagnostic.sourceLabel),
      }),
    )
    .toSorted(
      (a, b) =>
        a.sourceLabel.localeCompare(b.sourceLabel) ||
        a.kind.localeCompare(b.kind) ||
        a.severity.localeCompare(b.severity),
    )
  const summaries = skills
    .map((skill) =>
      SkillGuidanceSnapshot.Summary.make({
        name: skill.name,
        description: skill.description,
        sourceLabel: SkillGuidanceSnapshot.sourceLabel(skill.sourceLabel),
        digest: skill.digest,
      }),
    )
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) || a.sourceLabel.localeCompare(b.sourceLabel) || a.digest.localeCompare(b.digest),
    )
  const retained = summaries.reduce<typeof summaries>((result, skill) => {
    if (result.length >= Skill.MAX_GUIDANCE_ENTRIES) return result
    const next = [...result, skill]
    const value = SkillGuidanceSnapshot.Catalog.make({
      enabled,
      skills: next.map((item) => ({ ...item, description: undefined })),
      diagnostics,
      omitted: summaries.length - next.length,
    })
    if (bytes(render(value)) > Skill.MAX_GUIDANCE_BYTES) return result
    return next
  }, [])
  const omitted = summaries.length - retained.length
  const bounded = (limit: number) =>
    SkillGuidanceSnapshot.Catalog.make({
      enabled,
      skills: retained.map((skill) => ({ ...skill, description: shorten(skill.description, limit) })),
      diagnostics,
      omitted,
    })
  return bounded(descriptionLimit(bounded, 0, Skill.MAX_GUIDANCE_DESCRIPTION_CHARACTERS))
}

function descriptionLimit(
  catalog: (limit: number) => SkillGuidanceSnapshot.Catalog,
  lower: number,
  upper: number,
): number {
  if (lower === upper) return lower
  const middle = Math.ceil((lower + upper) / 2)
  if (bytes(render(catalog(middle))) <= Skill.MAX_GUIDANCE_BYTES) return descriptionLimit(catalog, middle, upper)
  return descriptionLimit(catalog, lower, middle - 1)
}

function shorten(value: string | undefined, limit: number) {
  if (value === undefined || value.length === 0 || limit === 0) return
  const characters = [...value]
  if (characters.length <= limit) return value
  return characters.slice(0, Math.max(0, limit - 1)).join("") + "…"
}

function bytes(value: string) {
  return new TextEncoder().encode(value).byteLength
}
