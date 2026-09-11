import { describe, expect } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { DateTime, Effect, Layer } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { SkillResolver } from "@opencode-ai/core/skill/resolver"
import { it } from "../lib/effect"

const sessionID = SessionSchema.ID.make("ses_skill_resolver")
const agentID = AgentV2.ID.make("build")
const invocationID = SkillInvocation.ID.make("ski_resolver")

const entry = (id: string, location: string): SkillRegistry.Entry => ({
  metadata: Skill.Metadata.make({
    id: Skill.ID.make(`skl_${id.repeat(64)}`),
    name: "review",
    description: "Review changes",
    sourceLabel: `Imported · ${id.repeat(8)}`,
    digest: Skill.Digest.make("a".repeat(64)),
  }),
  source: Skill.SourceDetail.make({
    kind: "imported",
    label: `Imported · ${id.repeat(8)}`,
    root: AbsolutePath.make("/controller/skills"),
    relativePath: RelativePath.make(`${location}/SKILL.md`),
  }),
  sourceKey: "directory:/controller/skills",
  location: AbsolutePath.make(`/controller/skills/${location}/SKILL.md`),
  content: "Review carefully",
})

describe("SkillResolver", () => {
  it.effect(
    "resolves durable invocations by unique local content identity and rejects ambiguous or inapplicable matches",
    () => {
      const first = entry("1", "review")
      let catalog = [first]
      let targetAvailable = true
      let denied = false
      let reads = 0
      const snapshot = SkillInvocation.Snapshot.make({
        id: invocationID,
        name: "review",
        description: "Review changes",
        digest: Skill.Digest.make("a".repeat(64)),
        source: { kind: "imported", label: "Imported" },
        content: "Review carefully",
        status: "loaded",
      })
      const context = [
        SessionMessage.User.make({
          id: SessionMessage.ID.make("msg_skill_resolver"),
          type: "user",
          text: "$review",
          skills: [{ source: { start: 0, end: 7, text: "$review" }, snapshot }],
          time: { created: DateTime.makeUnsafe(0) },
        }),
      ]
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
        [SessionStore.node, Layer.mock(SessionStore.Service, { context: () => Effect.succeed(context) })],
        [
          SkillV2.node,
          Layer.mock(SkillV2.Service, {
            catalog: () =>
              Effect.succeed({
                entries: catalog,
                snapshot: Skill.RegistrySnapshot.make({
                  revision: Skill.Digest.make("b".repeat(64)),
                  digest: Skill.Digest.make("b".repeat(64)),
                  skills: catalog.map((candidate) => candidate.metadata),
                  diagnostics: [],
                }),
              }),
            lookup: () =>
              Effect.succeed(
                targetAvailable
                  ? { status: "available" as const, entry: first }
                  : { status: "target-inapplicable" as const, entry: first },
              ),
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
        const resolved = yield* resolver.resolve({ sessionID, agent: agentID, reference: invocationID })
        expect(resolved).toEqual({ entry: first, invocationID })
        expect(reads).toBe(0)
        expect((yield* resolver.read(resolved)).entry).toBe(first)
        expect(reads).toBe(1)

        const portable = {
          ...entry("2", "review-global"),
          metadata: {
            ...entry("2", "review-global").metadata,
            sourceLabel: "OpenCode · global · 22222222",
          },
          source: {
            ...entry("2", "review-global").source,
            kind: "opencode-global" as const,
            label: "OpenCode · global · 22222222",
          },
        }
        catalog = [portable]
        expect(yield* resolver.resolve({ sessionID, agent: agentID, reference: invocationID })).toEqual({
          entry: portable,
          invocationID,
        })

        catalog = [
          first,
          {
            ...entry("3", "review-copy"),
            source: { ...entry("3", "review-copy").source, label: "Imported · 33333333" },
          },
        ]
        expect(
          (yield* Effect.flip(resolver.resolve({ sessionID, agent: agentID, reference: invocationID }))).kind,
        ).toBe("resource_unavailable_on_device")

        catalog = [first]
        denied = true
        expect(
          (yield* Effect.flip(resolver.resolve({ sessionID, agent: agentID, reference: invocationID }))).kind,
        ).toBe("skill_inapplicable")

        denied = false
        targetAvailable = false
        expect(
          (yield* Effect.flip(resolver.resolve({ sessionID, agent: agentID, reference: first.metadata.id }))).kind,
        ).toBe("skill_inapplicable")
      }).pipe(Effect.provide(layer))
    },
  )
})
