import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { it } from "../lib/effect"

const build = AgentV2.ID.make("build")
const digest = Skill.Digest.make("a".repeat(64))
const effect = Skill.Metadata.make({
  id: Skill.ID.make(`skl_${"1".repeat(64)}`),
  name: "effect",
  description: "Build applications with Effect",
  sourceLabel: "Imported · 11111111",
  digest,
})
const hidden = Skill.Metadata.make({
  id: Skill.ID.make(`skl_${"2".repeat(64)}`),
  name: "hidden",
  sourceLabel: "OpenCode config · 22222222",
  digest,
})
const denied = Skill.Metadata.make({
  id: Skill.ID.make(`skl_${"3".repeat(64)}`),
  name: "denied",
  description: "Must not be advertised",
  sourceLabel: "Built-in",
  digest,
})

const snapshot = (skills: Skill.Metadata[], diagnostics: Skill.Diagnostic[] = []) =>
  Skill.RegistrySnapshot.make({ revision: digest, digest, skills, diagnostics })

const layer = (list: () => Skill.RegistrySnapshot) =>
  AppNodeBuilder.build(SkillGuidance.node, [
    [SkillV2.node, Layer.mock(SkillV2.Service, { catalog: () => Effect.succeed({ snapshot: list(), entries: [] }) })],
  ])

describe("SkillGuidance", () => {
  it.effect("renders agent skills with optional descriptions and reconciles the complete available list", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    let skills = snapshot([hidden, denied, effect])
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))

      expect(initialized.baseline).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "Use the skill tool to load a skill when a task matches its description.",
          "<available_skills>",
          "  <skill>",
          "    <name>effect</name>",
          "    <description>Build applications with Effect</description>",
          "    <source>Imported</source>",
          "  </skill>",
          "  <skill>",
          "    <name>hidden</name>",
          "    <source>OpenCode config</source>",
          "  </skill>",
          "</available_skills>",
        ].join("\n"),
      )
      expect(JSON.stringify(initialized.snapshot)).not.toContain("skl_")
      expect(JSON.stringify(initialized.snapshot)).not.toContain("/skills/")

      skills = snapshot([])
      expect(
        yield* guidance
          .load({ id: agent.id, info: agent })
          .pipe(Effect.flatMap((context) => SystemContext.reconcileActivation(context, initialized.snapshot))),
      ).toMatchObject({
        _tag: "Updated",
        text: expect.stringContaining("No skills are currently available."),
      })
    }).pipe(Effect.provide(layer(() => skills)))
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))
      expect(initialized.baseline).toBe("")
      expect(initialized.snapshot["core/skill-guidance"]?.refresh).toBe("activation")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })

  it.effect("omits guidance when a resource-specific denial follows the global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "hidden", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toBe("")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })

  it.effect("retains specifically allowed skills after a global denial", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toContain("<name>effect</name>")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })

  it.effect("omits guidance when a specifically allowed skill is denied again", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [
        { action: "skill", resource: "*", effect: "deny" },
        { action: "skill", resource: "effect", effect: "allow" },
        { action: "skill", resource: "effect", effect: "deny" },
      ],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toBe("")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })
})
