import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SkillGuidance } from "@opencode-ai/core/skill/guidance"
import { SkillGuidanceSnapshot } from "@opencode-ai/core/skill/guidance-snapshot"
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
    let skills = snapshot(many)
    return Effect.gen(function* () {
      const guidance = yield* SkillGuidance.Service
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))
      const catalog = Schema.decodeUnknownSync(SkillGuidanceSnapshot.Catalog)(
        initialized.snapshot["core/skill-guidance"]?.value,
      )

      expect(new TextEncoder().encode(initialized.baseline).byteLength).toBeLessThanOrEqual(Skill.MAX_GUIDANCE_BYTES)
      expect(catalog.skills).toHaveLength(Skill.MAX_GUIDANCE_ENTRIES)
      expect(catalog.omitted).toBe(many.length - Skill.MAX_GUIDANCE_ENTRIES)
      expect(catalog.skills.every((skill) => [...(skill.description ?? "")].length <= 256)).toBe(true)
      expect(catalog.skills.some((skill) => [...(skill.description ?? "")].length < 256)).toBe(true)
      expect(initialized.baseline).toContain(`<omitted count="${catalog.omitted}">`)
      expect(many.every((skill) => [...(skill.description ?? "")].length === Skill.MAX_DESCRIPTION_CHARACTERS)).toBe(
        true,
      )

      skills = snapshot(many.toReversed())
      const repeated = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))
      expect(repeated.baseline).toBe(initialized.baseline)
      expect(repeated.snapshot["core/skill-guidance"]?.value).toEqual(
        initialized.snapshot["core/skill-guidance"]?.value,
      )
    }).pipe(Effect.provide(layer(() => skills)))
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
      const initialized = yield* guidance
        .load({ id: agent.id, info: agent })
        .pipe(Effect.flatMap(SystemContext.initialize))
      const catalog = Schema.decodeUnknownSync(SkillGuidanceSnapshot.Catalog)(
        initialized.snapshot["core/skill-guidance"]?.value,
      )

      expect(catalog.skills.map((skill) => skill.name)).toEqual([later.name])
      expect(catalog.omitted).toBe(1)
      expect(initialized.baseline).not.toContain(oversized.name)
      expect(initialized.baseline).toContain(`<name>${later.name}</name>`)
      expect(new TextEncoder().encode(initialized.baseline).byteLength).toBeLessThanOrEqual(Skill.MAX_GUIDANCE_BYTES)
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
      expect(
        (yield* guidance.load({ id: agent.id, info: agent }).pipe(Effect.flatMap(SystemContext.initialize))).baseline,
      ).toBe("")
    }).pipe(Effect.provide(layer(() => snapshot([effect]))))
  })
})
