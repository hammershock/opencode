import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SkillV2 } from "@opencode-ai/core/skill"
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
  it.effect("renders the complete authoritative list with optional descriptions", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const rendered = yield* guidance.load({ id: agent.id, info: agent })

      expect(rendered).toBe(
        [
          "Skills provide specialized instructions and workflows for specific tasks.",
          "The declaration below is the authoritative current Skill catalog for this Session and supersedes skill lists in conversation history.",
          "Answer questions about available skills directly from this list. The skill tool only loads one exact skill by name; it does not list skills and must never be called with names such as list or all.",
          "Use the skill tool to load one listed skill when the task matches its description.",
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
      expect(rendered).not.toContain("skl_")
      expect(rendered).not.toContain("/skills/")
    }).pipe(Effect.provide(layer(() => snapshot([hidden, denied, effect]))))
  })

  it.effect("omits guidance when the selected agent denies all skills", () => {
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(build),
      permissions: [{ action: "skill", resource: "*", effect: "deny" }],
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      expect(yield* guidance.load({ id: agent.id, info: agent })).toBe("")
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
      expect(yield* guidance.load({ id: agent.id, info: agent })).toBe("")
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
      expect(yield* guidance.load({ id: agent.id, info: agent })).toContain("<name>effect</name>")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })

  it.effect("bounds large multibyte catalogs before omitting stable later entries", () => {
    const agent = AgentV2.Info.make({ ...AgentV2.Info.empty(build), permissions: [] })
    const many = Array.from({ length: 80 }, (_, index) =>
      Skill.Metadata.make({
        id: Skill.ID.make(`skl_${index.toString(16).padStart(64, "0")}`),
        name: `skill-${index.toString().padStart(3, "0")}`,
        description: "界".repeat(Skill.MAX_DESCRIPTION_CHARACTERS),
        sourceLabel: `Imported · ${index.toString(16).padStart(8, "0")}`,
        digest,
      }),
    )
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const rendered = yield* guidance.load({ id: agent.id, info: agent })
      const descriptions = [...rendered.matchAll(/<description>(.*?)<\/description>/g)].map((match) => match[1]!)

      expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(Skill.MAX_GUIDANCE_BYTES)
      expect(rendered.match(/<skill>/g)).toHaveLength(Skill.MAX_GUIDANCE_ENTRIES)
      expect(rendered).toContain(`<omitted count="${many.length - Skill.MAX_GUIDANCE_ENTRIES}">`)
      expect(descriptions.every((description) => [...description].length <= 256)).toBe(true)
      expect(descriptions.some((description) => [...description].length < 256)).toBe(true)
      expect(many.every((skill) => [...(skill.description ?? "")].length === Skill.MAX_DESCRIPTION_CHARACTERS)).toBe(
        true,
      )

      expect(yield* guidance.load({ id: agent.id, info: agent }, snapshot(many.toReversed()))).toBe(rendered)
    }).pipe(Effect.provide(layer(() => snapshot(many))))
  })

  it.effect("omits an entry whose complete name cannot fit and continues with later names", () => {
    const agent = AgentV2.Info.make({ ...AgentV2.Info.empty(build), permissions: [] })
    const oversized = Skill.Metadata.make({
      ...effect,
      id: Skill.ID.make(`skl_${"4".repeat(64)}`),
      name: "a".repeat(Skill.MAX_GUIDANCE_BYTES),
    })
    const later = Skill.Metadata.make({
      ...effect,
      id: Skill.ID.make(`skl_${"5".repeat(64)}`),
      name: "z-later",
    })
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const rendered = yield* guidance.load({ id: agent.id, info: agent })

      expect(rendered.match(/<skill>/g)).toHaveLength(1)
      expect(rendered).toContain('<omitted count="1">')
      expect(rendered).not.toContain(oversized.name)
      expect(rendered).toContain(`<name>${later.name}</name>`)
      expect(new TextEncoder().encode(rendered).byteLength).toBeLessThanOrEqual(Skill.MAX_GUIDANCE_BYTES)
    }).pipe(Effect.provide(layer(() => snapshot([oversized, later]))))
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
      expect(yield* guidance.load({ id: agent.id, info: agent })).toBe("")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })
})
