import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { SkillResource } from "@opencode-ai/schema/skill-resource"
import { Effect, Layer, Schema } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
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
const invocationID = SkillInvocation.ID.make("ski_skillresource")

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
          yield* Effect.promise(() =>
            Promise.all([
              fs.mkdir(path.join(directory, "references"), { recursive: true }),
              fs.mkdir(path.join(directory, "many"), { recursive: true }),
              fs.mkdir(path.join(directory, "nested"), { recursive: true }),
            ]),
          )
          yield* Effect.promise(() =>
            Promise.all([
              fs.writeFile(path.join(directory, "SKILL.md"), "---\nname: review\n---\nReview carefully"),
              fs.writeFile(path.join(directory, "references", "guide.md"), "界".repeat(8_000)),
              fs.writeFile(path.join(directory, "binary.dat"), new Uint8Array([0, 1, 2, 3])),
              fs.writeFile(path.join(directory, "large.txt"), new Uint8Array(1024 * 1024 + 1)),
              fs.writeFile(path.join(directory, "nested", "SKILL.md"), "---\nname: nested\n---\nNested"),
              fs.writeFile(path.join(directory, "nested", "secret.txt"), "nested package resource"),
              fs.writeFile(outside, "outside"),
              ...Array.from({ length: 103 }, (_, index) =>
                fs.writeFile(path.join(directory, "many", `${index.toString().padStart(3, "0")}.txt`), "resource"),
              ),
              ...Array.from({ length: 60 }, async (_, index) => {
                const folder = path.join(directory, `long-${index.toString().padStart(3, "0")}-${"x".repeat(180)}`)
                await fs.mkdir(folder)
                await fs.writeFile(path.join(folder, `${"y".repeat(180)}.txt`), "resource")
              }),
            ]),
          )
          yield* Effect.promise(() => fs.link(outside, path.join(directory, "hardlink.txt")))
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
          let reads = 0
          const resolver = Layer.succeed(
            SkillResolver.Service,
            SkillResolver.Service.of({
              resolve: ({ reference }) =>
                Effect.succeed({ entry, ...(reference === invocationID ? { invocationID } : {}) }),
              resolveName: () => Effect.die("unused"),
              read: (resolved) =>
                Effect.sync(() => {
                  reads++
                  return resolved
                }),
            }),
          )
          const locationFilesystem = Layer.effect(
            FSUtil.Service,
            Effect.gen(function* () {
              const filesystem = yield* FSUtil.Service
              const unavailable = () => Effect.die("skill_resource used the Location filesystem")
              return FSUtil.Service.of({
                ...filesystem,
                ensureDir: unavailable,
                open: unavailable,
                readDirectoryEntries: unavailable,
                realPath: unavailable,
                stat: unavailable,
                writeFileString: unavailable,
              })
            }),
          ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
          const resourceLayer = AppNodeBuilder.build(
            LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, SkillResourceTool.node]),
            [
              [PermissionV2.node, permission],
              [SkillResolver.node, resolver],
              [FSUtil.locationNode, locationFilesystem],
              [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
            ],
          )

          return yield* Effect.gen(function* () {
            const registry = yield* ToolRegistry.Service
            expect((yield* toolDefinitions(registry))[0]).toMatchObject({
              name: "skill_resource",
              description: SkillResourceTool.description,
            })
            const call = (id: string, input: { skill: SkillResource.Reference; resource?: string; cursor?: string }) =>
              settleTool(registry, {
                sessionID,
                ...toolIdentity,
                call: { type: "tool-call", id, name: "skill_resource", input },
              })

            const listed = yield* call("call-manifest", { skill: invocationID })
            const listedOutput = yield* Schema.decodeUnknownEffect(SkillResource.Output)(listed.output?.structured)
            expect(listedOutput).toMatchObject({
              type: "manifest",
              skill: { invocationID, name: "review", digest: "2".repeat(64) },
              truncated: true,
            })
            expect(JSON.stringify(listedOutput)).not.toContain(skillID)
            if (listedOutput.type !== "manifest" || typeof listedOutput.nextCursor !== "string") return
            expect(listedOutput.entries.length).toBeLessThan(SkillResource.MAX_MANIFEST_ENTRIES)
            expect(Buffer.byteLength(JSON.stringify(listedOutput))).toBeLessThanOrEqual(
              SkillResource.MAX_MANIFEST_BYTES,
            )
            expect(listedOutput.entries[0]).toMatchObject({ resource: "binary.dat", size: 4 })
            expect(listedOutput.entries[1]).toMatchObject({ resource: "large.txt", size: 1024 * 1024 + 1 })
            const pages = [listedOutput]
            let nextCursor: string | undefined = listedOutput.nextCursor
            while (nextCursor) {
              const settlement: ToolRegistry.Settlement = yield* call(`call-manifest-${pages.length}`, {
                skill: invocationID,
                cursor: nextCursor,
              })
              const output: SkillResource.Output = yield* Schema.decodeUnknownEffect(SkillResource.Output)(
                settlement.output?.structured,
              )
              if (output.type !== "manifest") return
              expect(Buffer.byteLength(JSON.stringify(output))).toBeLessThanOrEqual(SkillResource.MAX_MANIFEST_BYTES)
              pages.push(output)
              nextCursor = output.nextCursor
            }
            const resources = pages.flatMap((page) => page.entries)
            expect(resources).toHaveLength(166)
            expect(resources.at(-1)).toMatchObject({
              resource: "references/guide.md",
              mime: "text/markdown",
            })
            expect(resources.map((entry) => entry.resource)).toEqual(
              resources.map((entry) => entry.resource).toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
            )
            expect(listed.outputPaths).toBeUndefined()
            expect(JSON.stringify(listed)).not.toContain(tmp.path)
            expect(JSON.stringify(listed)).not.toContain("SKILL.md")
            expect(JSON.stringify(listed)).not.toContain("escape.txt")
            expect(JSON.stringify(listed)).not.toContain("hardlink.txt")
            expect(JSON.stringify(pages)).not.toContain("nested/secret.txt")

            const first = yield* call("call-text-first", {
              skill: invocationID,
              resource: "references/guide.md",
            })
            const firstOutput = yield* Schema.decodeUnknownEffect(SkillResource.Output)(first.output?.structured)
            expect(firstOutput).toMatchObject({
              type: "text",
              resource: "references/guide.md",
              size: Buffer.byteLength("界".repeat(8_000)),
              truncated: true,
            })
            if (firstOutput.type !== "text" || typeof firstOutput.nextCursor !== "string") return
            expect(typeof firstOutput.content).toBe("string")
            const second = yield* call("call-text-second", {
              skill: invocationID,
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
              (yield* call("call-binary", { skill: invocationID, resource: "binary.dat" })).output?.structured,
            ).toMatchObject({
              type: "unsupported",
              resource: "binary.dat",
              diagnostic: "binary",
              digest: expect.any(String),
            })
            expect(
              (yield* call("call-large", { skill: invocationID, resource: "large.txt" })).output?.structured,
            ).toMatchObject({ type: "unsupported", resource: "large.txt", diagnostic: "resource_too_large" })
            expect((yield* call("call-traversal", { skill: invocationID, resource: "../outside.txt" })).result).toEqual(
              {
                type: "error",
                value: "skill_resource failed: invalid_resource_path",
              },
            )
            expect(
              (yield* call("call-encoded", { skill: invocationID, resource: "%2e%2e/outside.txt" })).result,
            ).toEqual({
              type: "error",
              value: "skill_resource failed: invalid_resource_path",
            })
            expect((yield* call("call-root", { skill: invocationID, resource: "SKILL.md" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: invalid_resource_path",
            })
            expect((yield* call("call-directory", { skill: invocationID, resource: "references" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: unsupported_resource_type",
            })
            expect((yield* call("call-missing", { skill: invocationID, resource: "missing.txt" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: resource_not_found",
            })
            expect((yield* call("call-hardlink", { skill: invocationID, resource: "hardlink.txt" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: resource_outside_package",
            })
            expect((yield* call("call-nested", { skill: invocationID, resource: "nested/secret.txt" })).result).toEqual(
              {
                type: "error",
                value: "skill_resource failed: resource_outside_package",
              },
            )
            expect((yield* call("call-cursor", { skill: invocationID, cursor: "invalid!" })).result).toEqual({
              type: "error",
              value: "skill_resource failed: invalid_cursor",
            })
            if (process.platform !== "win32")
              expect((yield* call("call-symlink", { skill: invocationID, resource: "escape.txt" })).result).toEqual({
                type: "error",
                value: "skill_resource failed: resource_outside_package",
              })
            const readsBeforeDenied = reads
            deny = true
            expect(
              (yield* call("call-denied", { skill: invocationID, resource: "references/guide.md" })).result,
            ).toEqual({
              type: "error",
              value: "skill_resource failed: permission_denied",
            })
            expect(reads).toBe(readsBeforeDenied)
            expect(assertions.every((assertion) => assertion.action === "skill")).toBe(true)
          }).pipe(Effect.provide(resourceLayer))
        }),
      ),
    ),
  )
})
