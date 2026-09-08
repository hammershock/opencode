import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncMetadata } from "@opencode-ai/core/sync/metadata"
import { sql } from "drizzle-orm"
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

        const remote = { ...base, ownerDeviceID: "remote", revision: 1, updatedAt: 4 }
        yield* metadata.apply("remote", [
          { ...remote, sessionID: "remote-live", title: "live" },
          { ...remote, sessionID: "remote-deleted", title: "deleted" },
        ])
        yield* metadata.apply("remote", [{ ...remote, sessionID: "remote-live", title: "live" }])
        yield* metadata.retain(["s", "remote-live"])
        expect((yield* metadata.list()).some((item) => item.sessionID === "remote-deleted")).toBe(false)

        const other = metadata.scope("other-space")
        yield* other.apply("device-b", [
          {
            sessionID: "s",
            title: "other",
            ownerDeviceID: "device-b",
            directory: "/other",
            revision: 1,
            updatedAt: 3,
          },
        ])
        expect((yield* metadata.list()).map((item) => item.sessionID)).toEqual(["remote-live", "s"])
        expect((yield* other.list()).map((item) => item.sessionID)).toEqual(["s"])

        const database = (yield* SyncDatabase.Service).db
        yield* database.run(sql`
          INSERT INTO sync_deletion_set (session_id, marker, deleted_at, space_id)
          VALUES ('s', ${JSON.stringify({ id: "delete", sessionID: "s", deletedAt: 4 })}, 4, 'legacy')
        `)
        yield* metadata.apply("stale-device", [{ ...base, title: "resurrected", revision: 99, updatedAt: 99 }])
        expect((yield* metadata.list()).some((item) => item.sessionID === "s")).toBe(false)
      }).pipe(Effect.scoped, Effect.provide(layers)),
    )
  })
})
