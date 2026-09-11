import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillResource } from "@opencode-ai/schema/skill-resource"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { SkillResolver } from "@opencode-ai/core/skill/resolver"
import { SkillResourceTool } from "@opencode-ai/core/tool/skill-resource"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { tmpdir } from "./fixture/tmpdir"
import { it } from "./lib/effect"
import { settleTool, toolIdentity, toolDefinitions } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_skill_resource_test")
const skillID = Skill.ID.make(`skl_${"1".repeat(64)}`)

describe("SkillResourceTool", () => {
  it.live("lists and pages controller resources without disclosing controller paths", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const directory = path.join(tmp.path, "review")
          const outside = path.join(tmp.path, "outside.txt")
          yield* Effect.promise(() => fs.mkdir(path.join(directory, "references"), { recursive: true }))
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: review\n---\nReview carefully"),
              fs.writeFile(path.join(directory, "references", "guide.md"), "界".repeat(8_000)),
              fs.writeFile(path.join(directory, "binary.dat"), new Uint8Array([0, 1, 2, 3])),
              fs.writeFile(path.join(directory, "large.txt"), new Uint8Array(1024 * 1024 + 1)),
              fs.writeFile(outside, "outside"),
            ]),
          )
          if (process.platform !== "win32")
            yield* Effect.promise(() => fs.symlink(outside, path.join(directory, "escape.txt")))

          const entry: SkillRegistry.Entry = {
            metadata: Skill.Metadata.make({
              id: skillID,
              name: "review",
              description: "Review changes",
              sourceLabel: "Imported · 11111111",
              digest: Skill.Digest.make("2".repeat(64)),
            }),
            source: Skill.SourceDetail.make({
              kind: "imported",
              label: "Imported · 11111111",
              root: AbsolutePath.make(tmp.path),
              relativePath: RelativePath.make("review/SKILL.md"),
            }),
            sourceKey: `directory:${tmp.path}`,
            location: AbsolutePath.make(path.join(directory, "SKILL.md")),
            content: "Review carefully",
          }
          const assertions: PermissionV2.AssertInput[] = []
          const permission = Layer.succeed(
            PermissionV2.Service,
            PermissionV2.Service.of({
              assert: (input) => Effect.sync(() => assertions.push(input)),
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
              resolve: () => Effect.succeed({ entry }),
              resolveName: () => Effect.die("unused"),
              read: Effect.succeed,
            }),
          )
          const resourceLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillResourceTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillResolver.node, resolver],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill_resource",
              description: SkillResourceTool.description,
            })
            const call = (id: string, input: { skill: Skill.ID; resource?: string; cursor?: string }) =>
              settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id, name: "skill_resource", input },
              })

            const listed = yield* call("call-manifest", { skill: skillID })
            expect(listed.output?.structured).toMatchObject({
              type: "manifest",
              skill: { skillID, name: "review", digest: "2".repeat(64) },
              entries: [
                { resource: "binary.dat", size: 4 },
                { resource: "large.txt", size: 1024 * 1024 + 1 },
                { resource: "references/guide.md", mime: "text/markdown" },
              ],
            })
            expect(JSON.stringify(listed)).not.toContain(tmp.path)
            expect(JSON.stringify(listed)).not.toContain("SKILL.md")
            expect(JSON.stringify(listed)).not.toContain("escape.txt")

            const first = yield* call("call-text-first", {
              skill: skillID,
              resource: "references/guide.md",
            })
            expect(first.output?.structured).toMatchObject({
              type: "text",
              resource: "references/guide.md",
              size: Buffer.byteLength("界".repeat(8_000)),
              truncated: true,
              content: expect.any(String),
              nextCursor: expect.any(String),
            })
            const firstOutput = yield* Schema.decodeUnknownEffect(SkillResource.Output)(first.output?.structured)
            if (firstOutput.type !== "text" || typeof firstOutput.nextCursor !== "string") return
            const second = yield* call("call-text-second", {
              skill: skillID,
              resource: "references/guide.md",
              cursor: firstOutput.nextCursor,
            })
            expect(second.output?.structured).toMatchObject({
              type: "text",
              resource: "references/guide.md",
              truncated: false,
            })
            const secondOutput = yield* Schema.decodeUnknownEffect(SkillResource.Output)(second.output?.structured)
            if (secondOutput.type === "text")
              expect(firstOutput.content + secondOutput.content).toBe("界".repeat(8_000))

            expect(
              (yield* call("call-binary", { skill: skillID, resource: "binary.dat" })).output?.structured,
            ).toMatchObject({
              type: "unsupported",
              resource: "binary.dat",
              diagnostic: "binary",
              digest: expect.any(String),
            })
            expect(
              (yield* call("call-large", { skill: skillID, resource: "large.txt" })).output?.structured,
            ).toMatchObject({ type: "unsupported", resource: "large.txt", diagnostic: "resource_too_large" })
            expect((yield* call("call-traversal", { skill: skillID, resource: "../outside.txt" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: invalid_resource_path",
            })
            expect((yield* call("call-encoded", { skill: skillID, resource: "%2e%2e/outside.txt" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: invalid_resource_path",
            })
            if (process.platform !== "win32")
              expect((yield* call("call-symlink", { skill: skillID, resource: "escape.txt" })).result).toEqual({
                type: "error",
                value: "skill_resource failed: resource_outside_package",
              })
            expect(assertions).toHaveLength(process.platform === "win32" ? 7 : 8)
          }).pipe(Effect.provide(resourceLayer))
        }),
      ),
    ),
  )
})
