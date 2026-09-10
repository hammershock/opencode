import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillDiscovery } from "@opencode-ai/core/skill/discovery"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"

const discovery = Layer.succeed(SkillDiscovery.Service, SkillDiscovery.Service.of({ pull: () => Effect.succeed([]) }))
const it = testEffect(AppNodeBuilder.build(SkillRegistry.node, [[SkillDiscovery.node, discovery]]))

const source = (directory: string, kind: "opencode-global" | "opencode-project" | "imported" = "imported") =>
  ({
    source: SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make(directory) }),
    options: { kind },
  }) satisfies SkillRegistry.Registration

async function writeSkill(
  root: string,
  directory: string,
  name: string,
  body: string,
  description = `${name} description`,
) {
  await fs.mkdir(path.join(root, directory), { recursive: true })
  await fs.writeFile(
    path.join(root, directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}`,
  )
}

describe("SkillRegistry", () => {
  it.live("produces stable identities and order-independent snapshots while retaining duplicate names", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          yield* Effect.promise(() =>
            Promise.all([
              writeSkill(global, "review", "review", "Global instructions"),
              writeSkill(project, "review", "review", "Project instructions"),
            ]),
          )

          const registry = yield* SkillRegistry.Service
          const first = yield* registry.load([source(project, "opencode-project"), source(global, "opencode-global")])
          const second = yield* registry.load([source(global, "opencode-global"), source(project, "opencode-project")])
          const moved = path.join(tmp.path, "moved")
          yield* Effect.promise(() => fs.cp(global, moved, { recursive: true }))
          const movedSnapshot = yield* registry.load([source(moved, "opencode-global")], { forceReload: true })

          expect(first.snapshot).toEqual(second.snapshot)
          expect(first.snapshot.skills).toHaveLength(2)
          expect(new Set(first.snapshot.skills.map((skill) => skill.id)).size).toBe(2)
          expect(first.snapshot.diagnostics.map((item) => item.kind)).toContain("duplicate-name")
          expect(first.snapshot.skills.every((skill) => !("content" in skill))).toBe(true)
          expect(first.snapshot.skills.map((skill) => skill.sourceLabel).every((label) => label.includes(" · "))).toBe(
            true,
          )
          expect(
            first.snapshot.skills
              .map((skill) => skill.sourceLabel)
              .some((label) => label.startsWith("OpenCode config")),
          ).toBe(true)
          expect(
            first.snapshot.skills
              .map((skill) => skill.sourceLabel)
              .some((label) => label.startsWith("Project .opencode")),
          ).toBe(true)
          expect(movedSnapshot.snapshot.skills[0]?.id).not.toBe(
            first.snapshot.skills.find((skill) => skill.sourceLabel.startsWith("OpenCode config"))?.id,
          )
        }),
      ),
    ),
  )

  it.live("deduplicates canonical roots and rejects symlink escapes", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "root")
          const alias = path.join(tmp.path, "alias")
          const outside = path.join(tmp.path, "outside")
          yield* Effect.promise(async () => {
            await writeSkill(root, "safe", "safe", "Safe instructions")
            await writeSkill(outside, "escape", "escape", "Outside instructions")
            await fs.symlink(root, alias, "dir")
            await fs.symlink(path.join(outside, "escape"), path.join(root, "escape"), "dir")
          })

          const registry = yield* SkillRegistry.Service
          const result = yield* registry.load([source(root), source(alias)], { forceReload: true })

          expect(result.snapshot.skills.map((skill) => skill.name)).toEqual(["safe"])
          expect(result.snapshot.diagnostics.map((item) => item.kind)).toContain("path-escape")
          expect(result.entries[0]?.source.root).toBe(AbsolutePath.make(yield* Effect.promise(() => fs.realpath(root))))
        }),
      ),
    ),
  )

  it.live("retains valid siblings and reports unavailable and malformed packages", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "skills")
          yield* Effect.promise(async () => {
            await writeSkill(root, "valid", "valid", "Valid instructions")
            await writeSkill(root, "mismatch", "different", "Mismatch instructions")
            await fs.mkdir(path.join(root, "broken"), { recursive: true })
            await fs.writeFile(path.join(root, "broken", "SKILL.md"), "---\nname: [broken\n---\nBroken")
          })

          const registry = yield* SkillRegistry.Service
          const result = yield* registry.load([source(root), source(path.join(tmp.path, "missing"))], {
            forceReload: true,
          })

          expect(result.snapshot.skills.map((skill) => skill.name)).toEqual(["valid"])
          expect(result.snapshot.diagnostics.map((item) => item.kind).toSorted()).toEqual([
            "invalid-name",
            "name-mismatch",
            "root-unavailable",
          ])
        }),
      ),
    ),
  )

  it.live("keeps cached packages until a forced reload", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const root = path.join(tmp.path, "skills")
          yield* Effect.promise(() => writeSkill(root, "deploy", "deploy", "Version one"))

          const registry = yield* SkillRegistry.Service
          const first = yield* registry.load([source(root)])
          yield* Effect.promise(() => writeSkill(root, "deploy", "deploy", "Version two", "Updated deploy description"))
          const cached = yield* registry.load([source(root)])
          const refreshed = yield* registry.load([source(root)], { forceReload: true })

          expect(cached.snapshot.digest).toBe(first.snapshot.digest)
          expect(cached.entries[0]?.content).toBe("Version one")
          expect(refreshed.snapshot.digest).not.toBe(first.snapshot.digest)
          expect(refreshed.entries[0]?.content).toBe("Version two")
          expect(refreshed.snapshot.skills[0]?.id).toBe(first.snapshot.skills[0]?.id)
          expect(refreshed.snapshot.skills[0]?.description).toBe("Updated deploy description")
        }),
      ),
    ),
  )
})
