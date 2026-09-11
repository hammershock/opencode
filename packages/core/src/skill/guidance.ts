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
        ...(catalog.skills.length === 0
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
  return SkillGuidanceSnapshot.Catalog.make({
    enabled:
      agent !== undefined &&
      !(skills.length === 0 && PermissionV2.evaluate("skill", "*", agent.permissions).effect === "deny"),
    skills: skills
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
          a.name.localeCompare(b.name) ||
          a.sourceLabel.localeCompare(b.sourceLabel) ||
          a.digest.localeCompare(b.digest),
      ),
    diagnostics: snapshot.diagnostics
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
      ),
  })
}
