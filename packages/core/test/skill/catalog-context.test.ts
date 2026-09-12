import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillCatalogContext } from "@opencode-ai/core/skill/catalog-context"
import { AgentV2 } from "@opencode-ai/core/agent"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionID } from "@opencode-ai/schema/session-id"
import { SkillPackageAccess } from "@opencode-ai/core/skill/package-access"
import { it } from "../lib/effect"

const digest = (value: string) => Skill.Digest.make(value.repeat(64))
const metadata = (name: string, value: string) =>
  Skill.Metadata.make({
    id: Skill.ID.make(`skl_${value.repeat(64)}`),
    name,
    description: `${name} description`,
    sourceLabel: `Imported · ${value.repeat(8)}`,
    digest: digest(value),
  })
const snapshot = (skills: Skill.Metadata[], diagnostics: Skill.Diagnostic[] = []) =>
  Skill.RegistrySnapshot.make({ revision: digest("a"), digest: digest("a"), skills, diagnostics })

describe("SkillCatalogContext", () => {
  it.effect("returns typed target and Agent permission failures before reading a body", () => {
    const review = metadata("review", "1")
    const entry: SkillRegistry.Entry = {
      metadata: review,
      source: Skill.SourceDetail.make({
        kind: "imported",
        label: review.sourceLabel,
        root: AbsolutePath.make("/controller/skills"),
        relativePath: RelativePath.make("review/SKILL.md"),
      }),
      sourceKey: "directory:/controller/skills",
      location: AbsolutePath.make("/controller/skills/review/SKILL.md"),
      content: "Review carefully",
    }
    let available = false
    let denied = false
    let reads = 0
    let prepares = 0
    let unavailable = false
    const agentID = AgentV2.ID.make("build")
    const layer = AppNodeBuilder.build(SkillCatalogContext.node, [
      [PluginV2.node, Layer.mock(PluginV2.Service, { wait: () => Effect.void })],
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
          lookup: () =>
            Effect.succeed(
              available ? { status: "available" as const, entry } : { status: "target-inapplicable" as const, entry },
            ),
        }),
      ],
      [
        SkillRegistry.node,
        Layer.mock(SkillRegistry.Service, {
          read: () =>
            Effect.sync(() => {
              reads++
              return entry
            }),
        }),
      ],
      [
        SkillPackageAccess.node,
        Layer.mock(SkillPackageAccess.Service, {
          prepare: () => {
            prepares++
            return unavailable
              ? Effect.fail(new SkillPackageAccess.Failure({ skillID: review.id, kind: "unavailable" }))
              : Effect.succeed({
                  path: AbsolutePath.make("/tmp/opencode-transit/skills/packages/review"),
                  temporary: true,
                })
          },
        }),
      ],
    ])
    const input = {
      sessionID: SessionID.make("ses_skill_failures"),
      messageID: SessionMessage.ID.make("msg_skill_failures"),
      text: "$review inspect",
      mentions: [{ id: review.id, name: review.name, source: { start: 0, end: 7, text: "$review" } }],
      admittedCatalog: Skill.AdmittedCatalog.make({
        revision: review.digest,
        skills: [
          Skill.AdmittedIdentity.make({
            id: review.id,
            name: review.name,
            sourceLabel: review.sourceLabel,
            digest: review.digest,
          }),
        ],
        digest: review.digest,
      }),
    }

    return Effect.gen(function* () {
      const catalogs = yield* SkillCatalogContext.Service
      expect((yield* Effect.flip(catalogs.resolve(input))).kind).toBe("target-inapplicable")
      expect(reads).toBe(0)
      expect(prepares).toBe(0)

      available = true
      denied = true
      expect((yield* Effect.flip(catalogs.resolve(input))).kind).toBe("permission-denied")
      expect(reads).toBe(0)
      expect(prepares).toBe(0)

      denied = false
      const collision = Skill.AdmittedCatalog.make({
        ...input.admittedCatalog,
        skills: [
          Skill.AdmittedIdentity.make({
            ...input.admittedCatalog.skills[0]!,
            id: Skill.ID.make(`skl_${"2".repeat(64)}`),
          }),
        ],
      })
      expect((yield* Effect.flip(catalogs.resolve({ ...input, admittedCatalog: collision }))).kind).toBe(
        "stale-catalog",
      )
      expect(reads).toBe(0)
      expect(prepares).toBe(0)
      const resolved = yield* catalogs.resolve(input)
      expect(resolved).toHaveLength(1)
      expect(resolved[0]?.snapshot.content).toContain(
        "Temporary package directory on this execution target: /tmp/opencode-transit/skills/packages/review",
      )
      expect(resolved[0]?.snapshot.content).toContain("persistent background work")
      expect(resolved[0]?.snapshot.content).not.toContain("/controller/skills")
      expect(reads).toBe(1)
      expect(prepares).toBe(1)

      unavailable = true
      expect((yield* Effect.flip(catalogs.resolve(input))).kind).toBe("unavailable")
      expect(reads).toBe(2)
      expect(prepares).toBe(2)
    }).pipe(Effect.provide(layer))
  })

  it.effect("materializes the first snapshot, reuses it, and retains it on transient reload failure", () => {
    let waits = 0
    let reloads = 0
    let reads = 0
    let current = snapshot([metadata("review", "1")])
    const layer = AppNodeBuilder.build(SkillCatalogContext.node, [
      [
        PluginV2.node,
        Layer.mock(PluginV2.Service, {
          wait: () => Effect.sync(() => waits++),
        }),
      ],
      [
        SkillV2.node,
        Layer.mock(SkillV2.Service, {
          reload: () => Effect.sync(() => reloads++),
          catalog: () =>
            Effect.sync(() => {
              reads++
              return { snapshot: current, entries: [] }
            }),
        }),
      ],
    ])

    return Effect.gen(function* () {
      const catalogs = yield* SkillCatalogContext.Service
      const first = yield* catalogs.load({ forceReload: false })
      const cached = yield* catalogs.load({ forceReload: false })

      expect(first.snapshot.skills.map((skill) => skill.name)).toEqual(["review"])
      expect(cached.snapshot).toBe(first.snapshot)
      expect({ waits, reloads, reads }).toEqual({ waits: 2, reloads: 1, reads: 1 })

      current = snapshot(
        [],
        [
          Skill.Diagnostic.make({
            kind: "root-unavailable",
            severity: "warning",
            sourceLabel: "Imported",
            message: "private path intentionally omitted from activation diagnostics",
          }),
        ],
      )
      const retained = yield* catalogs.load({ forceReload: true })

      expect(retained.transient).toBe(true)
      expect(retained.snapshot).toBe(first.snapshot)
      expect(retained.diagnostics).toEqual([{ kind: "root-unavailable", severity: "warning", sourceLabel: "Imported" }])
      expect({ waits, reloads, reads }).toEqual({ waits: 3, reloads: 2, reads: 2 })
    }).pipe(Effect.provide(layer))
  })
})
