import path from "path"
import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Effect, Layer } from "effect"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import { provideTmpdirInstance, testInstanceStoreLayer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    LayerNode.compile(Skill.node, [[LocationServiceMap.node, locationServiceMapLayer]]),
    LayerNode.compile(CrossSpawnSpawner.node),
    testInstanceStoreLayer,
  ),
)

const write = (root: string, directory: string, description: string) =>
  Bun.write(path.join(root, directory, "SKILL.md"), `---\nname: review\ndescription: ${description}\n---\n\n# Review\n`)

const withHome = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const previous = process.env.OPENCODE_TEST_HOME
      process.env.OPENCODE_TEST_HOME = home
      return previous
    }),
    () => effect,
    (previous) =>
      Effect.sync(() => {
        process.env.OPENCODE_TEST_HOME = previous
      }),
  )

describe("legacy Skill compatibility adapter", () => {
  it.live("projects the canonical OpenCode catalog without legacy external discovery", () =>
    provideTmpdirInstance(
      (directory) =>
        withHome(
          directory,
          Effect.gen(function* () {
            yield* Effect.promise(() =>
              Promise.all([
                write(path.join(directory, ".opencode", "skill"), "review", "Canonical review"),
                write(path.join(directory, ".claude", "skills"), "review", "Claude review"),
                write(path.join(directory, ".agents", "skills"), "review", "Agents review"),
              ]),
            )

            const skill = yield* Skill.Service
            const list = (yield* skill.all()).filter((item) => item.name !== "customize-opencode")
            expect(list).toHaveLength(1)
            expect(list[0]).toMatchObject({ name: "review", description: "Canonical review" })
            expect(list[0]!.location).toBe(path.join(directory, ".opencode", "skill", "review", "SKILL.md"))
            expect(yield* skill.get("review")).toEqual(list[0])
            expect(yield* skill.dirs()).toEqual([path.dirname(list[0]!.location)])
          }),
        ),
      { git: true },
    ),
  )

  it.live("retains duplicate canonical names and refuses name-only selection", () =>
    provideTmpdirInstance(
      (directory) =>
        withHome(
          directory,
          Effect.gen(function* () {
            const first = path.join(directory, "first")
            const second = path.join(directory, "second")
            yield* Effect.promise(() =>
              Promise.all([write(first, "review", "First"), write(second, "review", "Second")]),
            )
            yield* Effect.promise(() =>
              Bun.write(path.join(directory, "opencode.json"), JSON.stringify({ skills: { paths: [first, second] } })),
            )

            const skill = yield* Skill.Service
            expect(
              (yield* skill.all())
                .filter((item) => item.name === "review")
                .map((item) => item.description)
                .toSorted(),
            ).toEqual(["First", "Second"])
            expect(yield* skill.get("review")).toBeUndefined()
            const error = yield* Effect.flip(skill.require("review"))
            expect(error).toBeInstanceOf(Skill.AmbiguousError)
            if (error instanceof Skill.AmbiguousError) expect(error.sources).toHaveLength(2)
          }),
        ),
      { git: true },
    ),
  )

  it.effect("keeps legacy formatting and permission projection at the adapter boundary", () =>
    Effect.sync(() => {
      const list = [{ name: "review", description: "Review", location: "/tmp/review/SKILL.md", content: "# Review" }]
      expect(Skill.fmt(list, { verbose: true })).toContain("<name>review</name>")
      const agent = {
        name: "build",
        mode: "primary" as const,
        permission: Permission.fromConfig({ skill: { review: "deny" } }),
        options: {},
      }
      expect(Permission.evaluate("skill", list[0]!.name, agent.permission).action).toBe("deny")
    }),
  )
})
