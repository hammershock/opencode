import { describe, expect } from "bun:test"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SkillPackageAccess } from "@opencode-ai/core/skill/package-access"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { Skill } from "@opencode-ai/schema/skill"
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

describe("Rexd Skill package access", () => {
  let calls: string[] = []
  let closed = 0
  let failing = false
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
          release: async () => undefined,
        }
      },
      close: async () => {
        closed++
      },
    }),
  })
  const layer = LayerNode.compile(access, [
    [
      SkillPackageSnapshot.node,
      Layer.mock(SkillPackageSnapshot.Service, {
        create: () => Effect.succeed(snapshot),
      }),
    ],
  ])
  const it = testEffect(layer)

  it.effect("returns a temporary target path and deduplicates one Session digest", () =>
    Effect.gen(function* () {
      calls = []
      closed = 0
      failing = false
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
