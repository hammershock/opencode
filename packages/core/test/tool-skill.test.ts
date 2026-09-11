import { describe, expect } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { SkillResolver } from "@opencode-ai/core/skill/resolver"
import { SkillTool } from "@opencode-ai/core/tool/skill"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { it } from "./lib/effect"
import { toolIdentity, executeTool, settleTool, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_tool_test")

const entry = (name: string, value: string): SkillRegistry.Entry => ({
  metadata: Skill.Metadata.make({
    id: Skill.ID.make(`skl_${value.repeat(64)}`),
    name,
    description: `${name} guidance`,
    sourceLabel: `Imported · ${value.repeat(8)}`,
    digest: Skill.Digest.make(value.repeat(64)),
  }),
  source: Skill.SourceDetail.make({
    kind: "imported",
    label: `Imported · ${value.repeat(8)}`,
    root: AbsolutePath.make("/controller/skills"),
    relativePath: RelativePath.make(`${name}/SKILL.md`),
  }),
  sourceKey: "directory:/controller/skills",
  location: AbsolutePath.make(`/controller/skills/${name}/SKILL.md`),
  content: `# ${name}\n\nGuidance`,
})

describe("SkillTool", () => {
  it.effect("loads a durable snapshot without exposing controller paths and authorizes the selected name", () => {
    let current = [entry("effect", "1")]
    const assertions: PermissionV2.AssertInput[] = []
    let deny = false
    const permission = Layer.succeed(
      PermissionV2.Service,
      PermissionV2.Service.of({
        assert: (input) =>
          Effect.sync(() => assertions.push(input)).pipe(
            Effect.andThen(deny ? Effect.fail(new PermissionV2.BlockedError({ rules: [] })) : Effect.void),
          ),
        ask: () => Effect.die("unused"),
        reply: () => Effect.die("unused"),
        get: () => Effect.die("unused"),
        forSession: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
      }),
    )
    const resolver = Layer.succeed(
      SkillResolver.Service,
      SkillResolver.Service.of({
        resolve: () => Effect.die("unused"),
        resolveName: (input) => {
          const found = current.find((candidate) => candidate.metadata.name === input.name)
          return found
            ? Effect.succeed({ entry: found })
            : Effect.fail(new SkillResolver.Error({ kind: "resource_unavailable_on_device" }))
        },
        read: Effect.succeed,
      }),
    )
    const skillToolLayer = AppNodeBuilder.build(
      LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillTool.node]),
      [
        [PermissionV2.node, permission],
        [SkillResolver.node, resolver],
        [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
      ],
    )

    return Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      expect((yield* toolDefinitions(registry))[0]).toMatchObject({ name: "skill", description: SkillTool.description })
      const result = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-skill", name: "skill", input: { name: "effect" } },
      })
      expect(result).toMatchObject({ type: "text" })
      if (result.type !== "text") return
      expect(result.value).toContain('<skill_content name="effect" invocation="ski_')
      expect(result.value).toContain("Use skill_resource")
      expect(result.value).not.toContain("/controller/skills")

      const settled = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-skill-snapshot", name: "skill", input: { name: "effect" } },
      })
      expect(settled.output?.structured).toMatchObject({
        snapshot: {
          id: expect.stringMatching(/^ski_[0-9a-f]{64}$/),
          name: "effect",
          digest: "1".repeat(64),
          source: { kind: "imported", label: "Imported" },
          content: "# effect\n\nGuidance",
          status: "loaded",
        },
      })
      expect(assertions).toMatchObject([
        { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
        { sessionID, action: "skill", resources: ["effect"], save: ["effect"] },
      ])

      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-missing-skill", name: "skill", input: { name: "missing" } },
        }),
      ).toEqual({ type: "error", value: "Unable to load skill missing" })
      deny = true
      expect(
        yield* executeTool(registry, {
          sessionID,
          ...toolIdentity,
          call: { type: "tool-call", id: "call-denied-skill", name: "skill", input: { name: "effect" } },
        }),
      ).toEqual({ type: "error", value: "Unable to load skill effect" })
      deny = false
      current = [entry("public", "2")]
      const flat = yield* executeTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-public-skill", name: "skill", input: { name: "public" } },
      })
      expect(flat).toMatchObject({ type: "text" })
      if (flat.type === "text") expect(flat.value).not.toContain("/controller/skills")
    }).pipe(Effect.provide(skillToolLayer))
  })
})
