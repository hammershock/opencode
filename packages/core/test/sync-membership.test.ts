import { describe, expect, test } from "bun:test"
import { SyncMembership } from "@opencode-ai/core/sync/membership"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { Effect } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

describe("SyncMembership lifecycle reconciliation", () => {
  test("keeps inactive but locally bound spaces and finds only stale ownership after a crash", () => {
    expect(
      SyncMembership.staleSpaces(
        [
          { sessionID: "one", spaceID: "active", assignedAt: 1 },
          { sessionID: "two", spaceID: "inactive-bound", assignedAt: 2 },
          { sessionID: "three", spaceID: "removed", assignedAt: 3 },
          { sessionID: "four", spaceID: "removed", assignedAt: 4 },
        ],
        new Set(["active", "inactive-bound"]),
        ["removed-without-ownership"],
      ),
    ).toEqual(["removed", "removed-without-ownership"])
  })

  test("treats every ownership as stale after full device removal", () => {
    expect(
      SyncMembership.staleSpaces(
        [
          { sessionID: "one", spaceID: "a", assignedAt: 1 },
          { sessionID: "two", spaceID: "b", assignedAt: 2 },
        ],
        new Set(),
      ),
    ).toEqual(["a", "b"])
  })

  test("purges durable runtime state only for the removed space", async () => {
    await using tmp = await tmpdir()
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* SyncDatabase.Service).db
        yield* db.run(sql`INSERT INTO sync_event_outbox
          (event_id, aggregate_id, seq, payload, created_at, kind, space_id)
          VALUES ('gone-event', 'session', 1, '{}', 1, 'event', 'gone_'),
                 ('kept-event', 'session', 1, '{}', 1, 'event', 'kept')`)
        yield* db.run(sql`INSERT INTO sync_event_lease (name, owner, expires_at)
          VALUES ('gone_:upload', 'owner', 1), ('goneX:upload', 'owner', 1), ('kept:upload', 'owner', 1)`)
        yield* SyncDatabase.purgeSpace(db, "gone_")
        expect(
          yield* db.all<{ event_id: string }>(sql`SELECT event_id FROM sync_event_outbox ORDER BY event_id`),
        ).toEqual([{ event_id: "kept-event" }])
        expect(yield* db.all<{ name: string }>(sql`SELECT name FROM sync_event_lease ORDER BY name`)).toEqual([
          { name: "goneX:upload" },
          { name: "kept:upload" },
        ])
      }).pipe(Effect.provide(SyncDatabase.layerFromPath(path.join(tmp.path, "sync.db"))), Effect.scoped),
    )
  })
})
