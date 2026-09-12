import { describe, expect, test } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSkillCatalog } from "@opencode-ai/core/session/skill-catalog"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { SkillResolver } from "@opencode-ai/core/skill/resolver"
import { it } from "../lib/effect"

const agentID = AgentV2.ID.make("build")
const sessionID = SessionSchema.ID.make("ses_skill_resolver")

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
  test("projects exact identities through the selected Agent permissions", () => {
    const allowed = entry("1").metadata
    const denied = { ...entry("2").metadata, name: "denied" }
    const snapshot = Skill.RegistrySnapshot.make({
      revision: Skill.Digest.make("a".repeat(64)),
      digest: Skill.Digest.make("a".repeat(64)),
      skills: [allowed, denied],
      diagnostics: [],
    })
    const agent = AgentV2.Info.make({
      ...AgentV2.Info.empty(AgentV2.ID.make("restricted")),
      permissions: [{ action: "skill", resource: "denied", effect: "deny" }],
    })

    expect(SkillV2.preview(snapshot, agent)).toMatchObject({ revision: snapshot.revision, skills: [allowed] })
    expect(SkillV2.preview(snapshot, undefined).skills).toEqual([])
    expect(SkillV2.preview(snapshot, agent).digest).toBe(SkillV2.preview(snapshot, agent).digest)
  })

  it.effect("resolves only one permitted canonical name and reads through the registry", () => {
    const first = entry("1")
    let current: SkillV2.Lookup = { status: "available", entry: first }
    let denied = false
    let reads = 0
    const layer = AppNodeBuilder.build(LayerNode.group([Database.node, SkillResolver.node]), [
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
          lookup: () => Effect.succeed(current),
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
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/skill-resolver"), sandboxes: [] })
        .onConflictDoNothing()
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "skill-resolver",
          directory: "/skill-resolver",
          title: "skill resolver",
          version: "test",
        })
        .onConflictDoNothing()
        .run()
      const replace = (skills: ReadonlyArray<Skill.Metadata>) =>
        SessionSkillCatalog.replace(db, sessionID, {
          catalog: SessionSkillCatalog.make(Skill.Digest.make("a".repeat(64)), skills),
          guidance: "available skills",
        })
      yield* replace([first.metadata])

      const resolver = yield* SkillResolver.Service
      const resolved = yield* resolver.resolveName({ sessionID, agent: agentID, name: "review" })
      expect(resolved).toEqual({ entry: first })
      expect((yield* resolver.read(resolved)).entry).toBe(first)
      expect(reads).toBe(1)

      yield* replace([first.metadata, entry("2").metadata])
      expect((yield* Effect.flip(resolver.resolveName({ sessionID, agent: agentID, name: "review" }))).kind).toBe(
        "ambiguous_skill",
      )

      yield* replace([first.metadata])
      denied = true
      expect((yield* Effect.flip(resolver.resolveName({ sessionID, agent: agentID, name: "review" }))).kind).toBe(
        "skill_inapplicable",
      )

      denied = false
      expect((yield* Effect.flip(resolver.resolveName({ sessionID, agent: agentID, name: "missing" }))).kind).toBe(
        "not_admitted",
      )

      const latest = { ...entry("1"), content: "Updated guidance" }
      current = { status: "available", entry: latest }
      expect((yield* resolver.resolveName({ sessionID, agent: agentID, name: "review" })).entry.content).toBe(
        "Updated guidance",
      )

      current = { status: "missing" }
      expect((yield* Effect.flip(resolver.resolveName({ sessionID, agent: agentID, name: "review" }))).kind).toBe(
        "resource_unavailable_on_device",
      )
    }).pipe(Effect.provide(layer))
  })
})
