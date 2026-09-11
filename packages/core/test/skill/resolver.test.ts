import { describe, expect } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { SkillResolver } from "@opencode-ai/core/skill/resolver"
import { it } from "../lib/effect"

const agentID = AgentV2.ID.make("build")

const entry = (id: string): SkillRegistry.Entry => ({
  metadata: Skill.Metadata.make({
    id: Skill.ID.make(`skl_${id.repeat(64)}`),
    name: "review",
    description: "Review changes",
    sourceLabel: `Imported · ${id.repeat(8)}`,
    digest: Skill.Digest.make(id.repeat(64)),
  }),
  source: Skill.SourceDetail.make({
    kind: "imported",
    label: `Imported · ${id.repeat(8)}`,
    root: AbsolutePath.make("/controller/skills"),
    relativePath: RelativePath.make(`${id}/SKILL.md`),
  }),
  sourceKey: "directory:/controller/skills",
  location: AbsolutePath.make(`/controller/skills/${id}/SKILL.md`),
  content: "Review carefully",
})

describe("SkillResolver", () => {
  it.effect("resolves only one permitted canonical name and reads through the registry", () => {
    const first = entry("1")
    let catalog = [first]
    let denied = false
    let reads = 0
    const layer = AppNodeBuilder.build(SkillResolver.node, [
      [
        AgentV2.node,
        Layer.mock(AgentV2.Service, {
          select: () =>
            Effect.succeed({
              id: agentID,
              info: AgentV2.Info.make({
                ...AgentV2.Info.empty(agentID),
                permissions: denied ? [{ action: "skill", resource: "review", effect: "deny" }] : [],
              }),
            }),
        }),
      ],
      [
        SkillV2.node,
        Layer.mock(SkillV2.Service, {
          catalog: () =>
            Effect.succeed({
              entries: catalog,
              snapshot: Skill.RegistrySnapshot.make({
                revision: Skill.Digest.make("a".repeat(64)),
                digest: Skill.Digest.make("a".repeat(64)),
                skills: catalog.map((candidate) => candidate.metadata),
                diagnostics: [],
              }),
            }),
        }),
      ],
      [
        SkillRegistry.node,
        Layer.mock(SkillRegistry.Service, {
          read: (candidate) =>
            Effect.sync(() => {
              reads++
              return candidate
            }),
        }),
      ],
    ])

    return Effect.gen(function* () {
      const resolver = yield* SkillResolver.Service
      const resolved = yield* resolver.resolveName({ agent: agentID, name: "review" })
      expect(resolved).toEqual({ entry: first })
      expect((yield* resolver.read(resolved)).entry).toBe(first)
      expect(reads).toBe(1)

      catalog = [first, entry("2")]
      expect((yield* Effect.flip(resolver.resolveName({ agent: agentID, name: "review" }))).kind).toBe(
        "ambiguous_skill",
      )

      catalog = [first]
      denied = true
      expect((yield* Effect.flip(resolver.resolveName({ agent: agentID, name: "review" }))).kind).toBe(
        "resource_unavailable_on_device",
      )
    }).pipe(Effect.provide(layer))
  })
})
