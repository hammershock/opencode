import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncMetadata } from "@opencode-ai/core/sync/metadata"
import { tmpdir } from "./fixture/tmpdir"

describe("SyncMetadata", () => {
  test("hydrates searchable metadata first and converges revisions deterministically", async () => {
    await using tmp = await tmpdir()
    const layers = Layer.provideMerge(SyncMetadata.layer, SyncDatabase.layerFromPath(path.join(tmp.path, "sync.db")))
    await Effect.runPromise(
      Effect.gen(function* () {
        const metadata = yield* SyncMetadata.Service
        const base = { sessionID: "s", title: "old", ownerDeviceID: "a", directory: "/old", revision: 1, updatedAt: 1 }
        yield* metadata.apply("z", [base])
        yield* metadata.apply("b", [{ ...base, title: "new", revision: 2, updatedAt: 2 }])
        yield* metadata.apply("a", [{ ...base, title: "tie", revision: 2, updatedAt: 3 }])
        expect(yield* metadata.list()).toEqual([
          { ...base, title: "tie", revision: 2, updatedAt: 3, sourceDeviceID: "a", availability: "metadata-only" },
        ])
        yield* metadata.availability("s", "ready")
        expect((yield* metadata.list())[0]?.availability).toBe("ready")

        const other = metadata.scope("other-space")
        yield* other.apply("device-b", [
          {
            sessionID: "other",
            title: "other",
            ownerDeviceID: "device-b",
            directory: "/other",
            revision: 1,
            updatedAt: 3,
          },
        ])
        expect((yield* metadata.list()).map((item) => item.sessionID)).toEqual(["s"])
        expect((yield* other.list()).map((item) => item.sessionID)).toEqual(["other"])
      }).pipe(Effect.scoped, Effect.provide(layers)),
    )
  })
})
