import { describe, expect } from "bun:test"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Project } from "@opencode-ai/core/project"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SkillPackageAccess } from "@opencode-ai/core/skill/package-access"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { Skill } from "@opencode-ai/schema/skill"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Effect, Layer } from "effect"
import type { RexdLease } from "../../src/rexd/connection"
import { RexdLocationSession } from "../../src/rexd/location-session"
import { rexdSkillPackageAccessNode } from "../../src/rexd/skill-package-access"
import { testEffect } from "../lib/effect"

const entry: SkillRegistry.Entry = {
  metadata: Skill.Metadata.make({
    id: Skill.ID.make(`skl_${"1".repeat(64)}`),
    name: "review",
    description: "Review",
    sourceLabel: "Imported · 11111111",
    digest: Skill.Digest.make("2".repeat(64)),
  }),
  source: Skill.SourceDetail.make({
    kind: "imported",
    label: "Imported · 11111111",
    root: AbsolutePath.make("/controller/skills"),
    relativePath: RelativePath.make("review/SKILL.md"),
  }),
  sourceKey: "directory:/controller/skills",
  location: AbsolutePath.make("/controller/skills/review/SKILL.md"),
  content: "# Review",
}

const snapshot: SkillPackageSnapshot.Snapshot = {
  skillID: entry.metadata.id,
  root: AbsolutePath.make("/controller/skills/review"),
  files: [
    {
      path: RelativePath.make("SKILL.md"),
      size: 8,
      digest: Skill.Digest.make("3".repeat(64)),
      content: Buffer.from("# Review"),
    },
  ],
  size: 8,
  digest: Skill.Digest.make("4".repeat(64)),
}

const builtInEntry: SkillRegistry.Entry = {
  ...entry,
  source: Skill.SourceDetail.make({ kind: "built-in", label: "Built-in" }),
  sourceKey: "embedded:opencode/customize-opencode",
  location: AbsolutePath.make("/builtin/customize-opencode.md"),
}

describe("Rexd Skill package access", () => {
  let calls: string[] = []
  let closed = 0
  let failing = false
  let released: string[] = []
  let snapshots = 0
  let listener: EventV2.Subscriber | undefined
  const session = makeLocationNode({
    service: RexdLocationSession,
    layer: Layer.succeed(RexdLocationSession, {} as RexdLease),
    deps: [],
  })
  const access = rexdSkillPackageAccessNode(session, "target-test", {
    makeMaterializer: () => ({
      materialize: async (_snapshot, sessionID) => {
        calls.push(sessionID)
        if (failing) throw new Error("private remote path")
        return {
          path: `/tmp/opencode-transit/skills/packages/${snapshot.digest}`,
          renew: async () => undefined,
          release: async () => {
            released.push(sessionID)
          },
        }
      },
      close: async () => {
        closed++
      },
    }),
  })
  const layer = LayerNode.compile(access, [
    [
      EventV2.node,
      Layer.mock(EventV2.Service, {
        listen: (value) =>
          Effect.sync(() => {
            listener = value
            return Effect.sync(() => {
              listener = undefined
            })
          }),
      }),
    ],
    [
      SkillPackageSnapshot.node,
      Layer.mock(SkillPackageSnapshot.Service, {
        create: () =>
          Effect.sync(() => {
            snapshots++
            return snapshot
          }),
      }),
    ],
  ])
  const it = testEffect(layer)

  it.effect("does not materialize a built-in Skill", () =>
    Effect.gen(function* () {
      calls = []
      snapshots = 0
      const packages = yield* SkillPackageAccess.Service

      expect(
        yield* packages.prepare({ entry: builtInEntry, sessionID: SessionSchema.ID.make("session-built-in") }),
      ).toEqual({ temporary: false })
      expect(snapshots).toBe(0)
      expect(calls).toEqual([])
    }),
  )

  it.effect("returns a temporary target path and deduplicates one Session digest", () =>
    Effect.gen(function* () {
      calls = []
      closed = 0
      failing = false
      released = []
      const packages = yield* SkillPackageAccess.Service
      const first = yield* packages.prepare({ entry, sessionID: SessionSchema.ID.make("session-a") })
      const second = yield* packages.prepare({ entry, sessionID: SessionSchema.ID.make("session-a") })
      const third = yield* packages.prepare({ entry, sessionID: SessionSchema.ID.make("session-b") })

      expect(first).toEqual({
        path: AbsolutePath.make(`/tmp/opencode-transit/skills/packages/${snapshot.digest}`),
        temporary: true,
      })
      expect(second).toEqual(first)
      expect(third).toEqual(first)
      expect(calls).toEqual(["session-a", "session-b"])

      yield* listener!({
        id: EventV2.ID.make("evt_skill_session_deleted"),
        type: SessionV1.Event.Deleted.type,
        data: {
          sessionID: SessionSchema.ID.make("session-a"),
          info: {
            id: SessionSchema.ID.make("session-a"),
            slug: "session-a",
            projectID: Project.ID.make("global"),
            directory: "/workspace",
            title: "Session A",
            version: "test",
            time: { created: 0, updated: 0 },
          },
        },
      })
      expect(released).toEqual(["session-a"])

      yield* packages.prepare({ entry, sessionID: SessionSchema.ID.make("session-a") })
      expect(calls).toEqual(["session-a", "session-b", "session-a"])
    }),
  )

  it.effect("maps materialization failure to a path-free typed error", () =>
    Effect.gen(function* () {
      calls = []
      failing = true
      const packages = yield* SkillPackageAccess.Service
      const error = yield* Effect.flip(packages.prepare({ entry, sessionID: SessionSchema.ID.make("session-failure") }))
      expect(error).toEqual(new SkillPackageAccess.Failure({ skillID: entry.metadata.id, kind: "unavailable" }))
      expect(JSON.stringify(error)).not.toContain("private remote path")
    }),
  )
})
