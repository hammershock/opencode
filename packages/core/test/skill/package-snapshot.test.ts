import fs from "fs/promises"
import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Fiber } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { Skill } from "@opencode-ai/schema/skill"
import { tmpdir } from "../fixture/tmpdir"
import { testEffect } from "../lib/effect"

const it = testEffect(AppNodeBuilder.build(SkillPackageSnapshot.node))

const entry = (root: string): SkillRegistry.Entry => ({
  metadata: {
    id: Skill.ID.make(`skl_${"1".repeat(64)}`),
    name: "review",
    description: "Review changes",
    sourceLabel: "Test",
    digest: Skill.Digest.make("2".repeat(64)),
  },
  source: {
    kind: "imported",
    label: "Test",
    root: AbsolutePath.make(root),
    relativePath: RelativePath.make("review/SKILL.md"),
  },
  sourceKey: "test",
  location: AbsolutePath.make(path.join(root, "review", "SKILL.md")),
  content: "Review changes",
})

const fixture = <E, R>(run: (root: string) => Effect.Effect<void, E, R>) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(Effect.flatMap((tmp) => run(tmp.path)))

describe("SkillPackageSnapshot", () => {
  it.live("creates a stable sorted manifest with binary files and nested package ownership", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const skill = path.join(root, "review")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(skill, "z"), { recursive: true })
          await fs.mkdir(path.join(skill, "nested"), { recursive: true })
          await fs.writeFile(path.join(skill, "SKILL.md"), "review")
          await fs.writeFile(path.join(skill, "z", "binary.bin"), new Uint8Array([0, 1, 2, 255]))
          await fs.writeFile(path.join(skill, "a.txt"), "alpha")
          await fs.writeFile(path.join(skill, "nested", "SKILL.md"), "nested")
          await fs.writeFile(path.join(skill, "nested", "secret.txt"), "nested resource")
        })

        const service = yield* SkillPackageSnapshot.Service
        const first = yield* service.create(entry(root))
        const second = yield* service.create(entry(root))

        expect(first.files.map((file) => String(file.path))).toEqual(["SKILL.md", "a.txt", "z/binary.bin"])
        expect(Array.from(first.files[2]!.content)).toEqual([0, 1, 2, 255])
        expect(first.digest).toBe(second.digest)
        expect(first.size).toBe(15)
      }),
    ),
  )

  it.live("materializes in-root symlinks and rejects escapes and cycles", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const skill = path.join(root, "review")
        const outside = path.join(root, "outside.txt")
        yield* Effect.promise(async () => {
          await fs.mkdir(path.join(skill, "data"), { recursive: true })
          await fs.writeFile(path.join(skill, "SKILL.md"), "review")
          await fs.writeFile(path.join(skill, "data", "value.txt"), "value")
          await fs.writeFile(outside, "outside")
          await fs.symlink(path.join(skill, "data", "value.txt"), path.join(skill, "linked.txt"))
        })

        const service = yield* SkillPackageSnapshot.Service
        expect((yield* service.create(entry(root))).files.map((file) => String(file.path))).toContain("linked.txt")
        const aliases = path.join(root, "aliases")
        yield* Effect.promise(async () => {
          await fs.mkdir(aliases)
          await fs.symlink(skill, path.join(aliases, "review"))
        })
        expect((yield* service.create(entry(aliases))).root).toBe(
          AbsolutePath.make(yield* Effect.promise(() => fs.realpath(skill))),
        )

        yield* Effect.promise(() => fs.symlink(outside, path.join(skill, "escape.txt")))
        expect((yield* Effect.flip(service.create(entry(root)))).kind).toBe("outside-package")
        yield* Effect.promise(async () => {
          await fs.unlink(path.join(skill, "escape.txt"))
          await fs.symlink(skill, path.join(skill, "loop"))
        })
        expect((yield* Effect.flip(service.create(entry(root)))).kind).toBe("cycle")
      }),
    ),
  )

  it.live("rejects case collisions and files above the per-file limit", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const skill = path.join(root, "review")
        yield* Effect.promise(async () => {
          await fs.mkdir(skill, { recursive: true })
          await fs.writeFile(path.join(skill, "SKILL.md"), "review")
          await fs.writeFile(path.join(skill, "Readme.txt"), "one")
          await fs.writeFile(path.join(skill, "README.txt"), "two")
        })

        const service = yield* SkillPackageSnapshot.Service
        const names = yield* Effect.promise(() => fs.readdir(skill))
        if (names.filter((name) => name.toLowerCase() === "readme.txt").length === 2)
          expect((yield* Effect.flip(service.create(entry(root)))).kind).toBe("case-collision")
        yield* Effect.promise(async () => {
          await fs.rm(path.join(skill, "README.txt"), { force: true })
          await fs.rm(path.join(skill, "Readme.txt"), { force: true })
          await fs.writeFile(path.join(skill, "large.bin"), new Uint8Array(SkillPackageSnapshot.MAX_FILE_BYTES + 1))
        })
        expect((yield* Effect.flip(service.create(entry(root)))).kind).toBe("file-too-large")
      }),
    ),
  )

  it.live("accepts exact package limits and rejects the first value above them", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const skill = path.join(root, "review")
        yield* Effect.promise(async () => {
          await fs.mkdir(skill, { recursive: true })
          await fs.writeFile(path.join(skill, "SKILL.md"), "")
          const chunk = new Uint8Array(SkillPackageSnapshot.MAX_FILE_BYTES)
          await Promise.all(
            Array.from({ length: 4 }, (_, index) => fs.writeFile(path.join(skill, `${index}.bin`), chunk)),
          )
        })

        const service = yield* SkillPackageSnapshot.Service
        expect((yield* service.create(entry(root))).size).toBe(SkillPackageSnapshot.MAX_PACKAGE_BYTES)
        yield* Effect.promise(() => fs.writeFile(path.join(skill, "SKILL.md"), "x"))
        expect((yield* Effect.flip(service.create(entry(root)))).kind).toBe("package-too-large")
      }),
    ),
  )

  it.live("accepts exactly 4096 files and rejects one more", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const skill = path.join(root, "review")
        yield* Effect.promise(async () => {
          await fs.mkdir(skill, { recursive: true })
          await fs.writeFile(path.join(skill, "SKILL.md"), "")
          await Promise.all(
            Array.from({ length: SkillPackageSnapshot.MAX_FILES - 1 }, (_, index) =>
              fs.writeFile(path.join(skill, `${index.toString().padStart(4, "0")}.txt`), ""),
            ),
          )
        })

        const service = yield* SkillPackageSnapshot.Service
        expect((yield* service.create(entry(root))).files).toHaveLength(SkillPackageSnapshot.MAX_FILES)
        yield* Effect.promise(() => fs.writeFile(path.join(skill, "overflow.txt"), ""))
        expect((yield* Effect.flip(service.create(entry(root)))).kind).toBe("too-many-files")
      }),
    ),
  )

  it.live("fails instead of returning bytes changed during the snapshot", () =>
    fixture((root) =>
      Effect.gen(function* () {
        const skill = path.join(root, "review")
        const changing = path.join(skill, "changing.bin")
        yield* Effect.promise(async () => {
          await fs.mkdir(skill, { recursive: true })
          await fs.writeFile(path.join(skill, "SKILL.md"), "review")
          await fs.writeFile(changing, new Uint8Array(SkillPackageSnapshot.MAX_FILE_BYTES))
        })

        const state = { running: true }
        const writer = yield* Effect.promise(async () => {
          const file = await fs.open(changing, "r+")
          let value = 0
          while (state.running) {
            await file.write(new Uint8Array([value++ % 2]), 0, 1, 0)
            await Bun.sleep(0)
          }
          await file.close()
        }).pipe(Effect.forkChild)
        const result = yield* Effect.flip((yield* SkillPackageSnapshot.Service).create(entry(root))).pipe(
          Effect.ensuring(Effect.sync(() => (state.running = false))),
        )
        yield* Fiber.join(writer)

        expect(result.kind).toBe("unstable")
      }),
    ),
  )
})
