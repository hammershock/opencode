import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncOwnership } from "@opencode-ai/core/sync/ownership"
import { tmpdir } from "./fixture/tmpdir"

describe("SyncOwnership", () => {
  test("assigns each Session to one space and unassigns a deleted space", async () => {
    await using tmp = await tmpdir()
    const layers = Layer.provideMerge(SyncOwnership.layer, SyncDatabase.layerFromPath(path.join(tmp.path, "sync.db")))
    await Effect.runPromise(
      Effect.gen(function* () {
        const ownership = yield* SyncOwnership.Service
        yield* ownership.assign("ses_1", "space-a", 1)
        yield* ownership.assign("ses_2", "space-a", 2)
        yield* ownership.assign("ses_1", "space-b", 3)

        expect(yield* ownership.get("ses_1")).toEqual({ sessionID: "ses_1", spaceID: "space-b", assignedAt: 3 })
        expect((yield* ownership.list("space-a")).map((item) => item.sessionID)).toEqual(["ses_2"])
        expect(yield* ownership.unassignSpace("space-a")).toEqual(["ses_2"])
        expect(yield* ownership.get("ses_2")).toBeUndefined()
      }).pipe(Effect.scoped, Effect.provide(layers)),
    )
  })
})
