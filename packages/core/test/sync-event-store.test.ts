import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer } from "effect"
import { sql } from "drizzle-orm"
import path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { tmpdir } from "./fixture/tmpdir"

const device = SyncEvent.DeviceID.make("device-a")
const remote = SyncEvent.DeviceID.make("device-b")
const event = (id: string, seq: number): SyncEvent.Envelope => ({
  id,
  aggregateID: "session-a",
  seq,
  type: "session.test@1",
  data: { text: id },
})

const segment = (generation: number, events: SyncEvent.Envelope[]) =>
  SyncEvent.Segment.make({
    version: 1,
    id: SyncEvent.SegmentID.make(`${remote}:${generation}`),
    deviceID: remote,
    generation,
    createdAt: 10,
    operations: events.map((item) => ({ kind: "event" as const, event: item })),
  })

async function run<A, E>(effect: Effect.Effect<A, E, SyncEventStore.Service | SyncDatabase.Service>) {
  await using tmp = await tmpdir()
  const database = SyncDatabase.layerFromPath(path.join(tmp.path, "sync.db"))
  return await Effect.runPromise(
    effect.pipe(Effect.scoped, Effect.provide(Layer.provideMerge(SyncEventStore.layer, database))),
  )
}

describe("SyncEventStore", () => {
  test("migrates a v2 sync database to the durable apply journal", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "sync.db")
    const raw = new BunDatabase(filename)
    raw.run("CREATE TABLE sync_schema (version INTEGER PRIMARY KEY)")
    raw.run("INSERT INTO sync_schema (version) VALUES (2)")
    raw.run(`CREATE TABLE sync_event_outbox (
      event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, segment_id TEXT, kind TEXT NOT NULL DEFAULT 'event'
    )`)
    raw.run(`CREATE TABLE sync_event_segment (
      id TEXT PRIMARY KEY, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
      payload TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER,
      UNIQUE(device_id, generation)
    )`)
    raw.run("CREATE TABLE sync_event_head (device_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)")
    raw.run("CREATE TABLE sync_event_cursor (device_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL)")
    raw.run(`CREATE TABLE sync_remote_segment (
      device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(device_id, generation)
    )`)
    raw.run(`CREATE TABLE sync_remote_event (
      device_id TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
      PRIMARY KEY(device_id, event_id)
    )`)
    raw.run(`CREATE TABLE sync_deletion_set (
      session_id TEXT PRIMARY KEY, marker TEXT NOT NULL, deleted_at INTEGER NOT NULL
    )`)
    raw.close()
    const database = SyncDatabase.layerFromPath(filename)
    const version = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* SyncDatabase.Service
        return yield* db.get<{ version: number }>(sql`SELECT MAX(version) AS version FROM sync_schema`)
      }).pipe(Effect.scoped, Effect.provide(database)),
    )
    expect(version).toEqual({ version: 6 })
  })

  test("preserves v5 rows while rebuilding space-composite keys and the immutable trigger", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "sync.db")
    const raw = new BunDatabase(filename)
    raw.exec(`
      CREATE TABLE sync_schema (version INTEGER PRIMARY KEY);
      INSERT INTO sync_schema VALUES (5);
      CREATE TABLE sync_event_outbox (event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, segment_id TEXT, kind TEXT NOT NULL DEFAULT 'event', space_id TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE sync_event_segment (id TEXT PRIMARY KEY, device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER, space_id TEXT NOT NULL DEFAULT 'legacy', UNIQUE(device_id, generation));
      CREATE TABLE sync_event_head (device_id TEXT PRIMARY KEY, generation INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE sync_event_cursor (device_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE sync_remote_segment (device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(device_id, generation));
      CREATE TABLE sync_remote_event (device_id TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(device_id, event_id));
      CREATE TABLE sync_deletion_set (session_id TEXT PRIMARY KEY, marker TEXT NOT NULL, deleted_at INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy');
      CREATE TABLE sync_apply_journal (device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(device_id, generation));
      CREATE TABLE sync_session_metadata (session_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source_device TEXT NOT NULL, revision INTEGER NOT NULL, availability TEXT NOT NULL, updated_at INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy');
      CREATE TRIGGER sync_event_segment_immutable BEFORE UPDATE OF device_id, generation, payload, created_at ON sync_event_segment BEGIN SELECT RAISE(ABORT, 'sync event segments are immutable'); END;
      CREATE INDEX sync_event_outbox_space_idx ON sync_event_outbox(space_id, segment_id, created_at);
      CREATE INDEX sync_event_segment_space_idx ON sync_event_segment(space_id, device_id, generation);
      CREATE INDEX sync_event_cursor_space_idx ON sync_event_cursor(space_id, device_id);
      INSERT INTO sync_event_outbox VALUES ('event', 'session', 0, '{}', 1, NULL, 'event', 'kept');
      INSERT INTO sync_event_segment VALUES ('segment', 'device', 1, '{}', 1, NULL, 'kept');
      INSERT INTO sync_event_head VALUES ('device', 1, 'kept');
      INSERT INTO sync_event_cursor VALUES ('device', 1, 'kept');
      INSERT INTO sync_remote_segment VALUES ('device', 1, '{}', 'kept');
      INSERT INTO sync_remote_event VALUES ('device', 'event', 'fingerprint', 'kept');
      INSERT INTO sync_deletion_set VALUES ('session', '{}', 1, 'kept');
      INSERT INTO sync_apply_journal VALUES ('device', 1, '{}', 1, 'kept');
      INSERT INTO sync_session_metadata VALUES ('session', '{}', 'device', 1, 'ready', 1, 'kept');
    `)
    raw.close()

    const database = SyncDatabase.layerFromPath(filename)
    await Effect.runPromise(
      Effect.gen(function* () {
        const db = (yield* SyncDatabase.Service).db
        expect(yield* db.get(sql`SELECT MAX(version) AS version FROM sync_schema`)).toEqual({ version: 6 })
        for (const table of [
          "sync_event_outbox",
          "sync_event_segment",
          "sync_event_head",
          "sync_event_cursor",
          "sync_remote_segment",
          "sync_remote_event",
          "sync_deletion_set",
          "sync_apply_journal",
          "sync_session_metadata",
        ]) {
          expect(yield* db.get(sql.raw(`SELECT space_id FROM ${table}`))).toEqual({ space_id: "kept" })
        }
        expect(
          (yield* db.all<{ name: string; pk: number }>(sql`PRAGMA table_info(sync_event_cursor)`))
            .filter((column) => column.pk > 0)
            .sort((a, b) => a.pk - b.pk)
            .map((column) => column.name),
        ).toEqual(["space_id", "device_id"])
        expect(
          yield* db
            .run(sql`UPDATE sync_event_segment SET payload = 'changed' WHERE space_id = 'kept' AND id = 'segment'`)
            .pipe(Effect.exit),
        ).toSatisfy(Exit.isFailure)
      }).pipe(Effect.scoped, Effect.provide(database)),
    )
  })

  test("durably seals ordered outbox events into one immutable per-device generation", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        yield* store.enqueue(event("later", 1), 20)
        yield* store.enqueue(event("first", 0), 10)
        yield* store.enqueue(event("first", 0), 10)

        expect((yield* store.pending(10)).map((item) => item.id)).toEqual(["first", "later"])
        const sealed = yield* store.seal(device, 10, 30)
        expect(sealed).toMatchObject({ generation: 1, deviceID: device })
        expect(sealed?.operations.map((item) => (item.kind === "event" ? item.event.id : item.tombstone.id))).toEqual([
          "first",
          "later",
        ])
        expect(yield* store.seal(device, 10, 40)).toEqual(sealed)
        expect(yield* store.head(device)).toBe(0)
        const database = (yield* SyncDatabase.Service).db
        const mutation = yield* database
          .run(sql`UPDATE sync_event_segment SET payload = ${"changed"} WHERE id = ${sealed!.id}`)
          .pipe(Effect.exit)
        expect(Exit.isFailure(mutation)).toBe(true)

        yield* store.acknowledge(sealed!.id)
        expect(yield* store.head(device)).toBe(1)
        expect(yield* store.pending(10)).toEqual([])
        expect(yield* store.seal(device, 10)).toBeUndefined()
      }),
    )
  })

  test("packs pending events from multiple Sessions into one segment", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        yield* store.enqueue(event("first-session", 0), 10)
        yield* store.enqueue({ ...event("second-session", 0), aggregateID: "session-b" }, 11)

        const sealed = yield* store.seal(device, 256, 20)
        expect(sealed?.operations.map((item) => item.kind === "event" && item.event.aggregateID)).toEqual([
          "session-a",
          "session-b",
        ])
      }),
    )
  })

  test("permits the same device identity and generation in two sync spaces", async () => {
    await run(
      Effect.gen(function* () {
        const root = yield* SyncEventStore.Service
        const first = root.scope("space-a")
        const second = root.scope("space-b")
        yield* first.enqueue(event("shared-event", 0))
        yield* second.enqueue(event("shared-event", 0))
        expect((yield* first.pending(10)).map((item) => item.id)).toEqual(["shared-event"])
        expect((yield* second.pending(10)).map((item) => item.id)).toEqual(["shared-event"])
        expect(yield* first.acquire("upload", "first", 1_000, 0)).toBe(true)
        expect(yield* second.acquire("upload", "second", 1_000, 0)).toBe(true)
        const firstSegment = yield* first.seal(device, 10, 10)
        const secondSegment = yield* second.seal(device, 10, 10)
        expect(firstSegment).toEqual(secondSegment)
        yield* first.acknowledge(firstSegment!.id)
        yield* second.acknowledge(secondSegment!.id)
        expect(yield* first.head(device)).toBe(1)
        expect(yield* second.head(device)).toBe(1)

        const remoteSegment = segment(1, [event("remote-shared", 0)])
        const projector = { project: () => Effect.void, delete: () => Effect.void }
        yield* first.apply(remoteSegment, projector)
        yield* second.apply(remoteSegment, projector)
        expect(yield* first.cursor(remote)).toBe(1)
        expect(yield* second.cursor(remote)).toBe(1)
      }),
    )
  })

  test("keeps outbox rows when segment acknowledgement does not commit", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        yield* store.enqueue(event("one", 0))
        const sealed = yield* store.seal(device, 10)
        expect(sealed).toBeDefined()
        expect(yield* store.seal(device, 10)).toEqual(sealed)
      }),
    )
  })

  test("makes concurrent outbox retries idempotent and rejects divergent payloads", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        yield* Effect.all(
          Array.from({ length: 12 }, () => store.enqueue(event("same", 0))),
          {
            concurrency: "unbounded",
          },
        )
        expect(yield* store.pending(20)).toEqual([event("same", 0)])
        const divergent = yield* store.enqueue({ ...event("same", 0), data: { text: "different" } }).pipe(Effect.exit)
        expect(Exit.isFailure(divergent)).toBe(true)
        expect(yield* store.pending(20)).toEqual([event("same", 0)])
      }),
    )
  })

  test("requeues retained segments acknowledged before a replacement cloud root", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        yield* store.enqueue(event("before-reset", 0), 10)
        const sealed = yield* store.seal(device, 10, 20)
        yield* store.acknowledge(sealed!.id)
        expect(yield* store.seal(device, 10, 30)).toBeUndefined()

        yield* store.requeueAcknowledgedBefore(device, Date.now() + 1_000)
        expect(yield* store.seal(device, 10, 40)).toEqual(sealed)
      }),
    )
  })

  test("advances a remote cursor only after every projection commits", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const database = (yield* SyncDatabase.Service).db
        yield* database.run(sql`CREATE TABLE projection_probe (event_id TEXT PRIMARY KEY)`)
        const failure = yield* store
          .apply(segment(1, [event("one", 0), event("two", 1)]), {
            delete: () => Effect.void,
            project: (tx, item) =>
              item.id === "two"
                ? Effect.fail("projection failed")
                : tx.run(sql`INSERT INTO projection_probe (event_id) VALUES (${item.id})`).pipe(Effect.asVoid),
          })
          .pipe(Effect.exit)

        expect(Exit.isFailure(failure)).toBe(true)
        expect(yield* store.cursor(remote)).toBe(0)
        expect(yield* database.all(sql`SELECT * FROM projection_probe`)).toEqual([])

        yield* store.apply(segment(1, [event("one", 0), event("two", 1)]), {
          delete: () => Effect.void,
          project: (tx, item) =>
            tx.run(sql`INSERT INTO projection_probe (event_id) VALUES (${item.id})`).pipe(Effect.asVoid),
        })
        expect(yield* store.cursor(remote)).toBe(1)
        expect(yield* database.all(sql`SELECT event_id FROM projection_probe ORDER BY event_id`)).toEqual([
          { event_id: "one" },
          { event_id: "two" },
        ])
      }),
    )
  })

  test("makes replay idempotent and rejects a divergent reused event id", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const database = (yield* SyncDatabase.Service).db
        yield* database.run(sql`CREATE TABLE projection_count (value INTEGER NOT NULL)`)
        yield* database.run(sql`INSERT INTO projection_count (value) VALUES (0)`)
        const projector = {
          delete: () => Effect.void,
          project: (tx: SyncEventStore.Transaction) =>
            tx.run(sql`UPDATE projection_count SET value = value + 1`).pipe(Effect.asVoid),
        }
        yield* store.apply(segment(1, [event("one", 0)]), projector)
        yield* store.apply(segment(1, [event("one", 0)]), projector)
        expect(yield* database.get(sql`SELECT value FROM projection_count`)).toEqual({ value: 1 })

        const incomplete = yield* store.apply(segment(1, []), projector).pipe(Effect.exit)
        expect(Exit.isFailure(incomplete)).toBe(true)
        expect(yield* store.cursor(remote)).toBe(1)

        const exit = yield* store
          .apply(segment(1, [{ ...event("one", 0), data: { text: "changed" } }]), projector)
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        expect(yield* store.cursor(remote)).toBe(1)
      }),
    )
  })

  test("makes deletion permanent across late and replayed Session events", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const database = (yield* SyncDatabase.Service).db
        yield* database.run(sql`CREATE TABLE projection_session (id TEXT PRIMARY KEY)`)
        const projector: SyncEvent.Projector<SyncEventStore.Transaction> = {
          project: (tx, item) =>
            tx.run(sql`INSERT OR IGNORE INTO projection_session (id) VALUES (${item.aggregateID})`).pipe(Effect.asVoid),
          delete: (tx, item) =>
            tx.run(sql`DELETE FROM projection_session WHERE id = ${item.sessionID}`).pipe(Effect.asVoid),
        }
        yield* store.apply(segment(1, [event("before", 0)]), projector)
        expect(yield* database.all(sql`SELECT id FROM projection_session`)).toEqual([{ id: "session-a" }])

        const tombstone = SyncEvent.Tombstone.make({ id: "delete-a", sessionID: "session-a", deletedAt: 20 })
        const deletion = SyncEvent.Segment.make({
          version: 1,
          id: SyncEvent.SegmentID.make(`${remote}:2`),
          deviceID: remote,
          generation: 2,
          createdAt: 20,
          operations: [{ kind: "tombstone", tombstone }],
        })
        yield* store.apply(deletion, projector)
        expect(yield* database.all(sql`SELECT id FROM projection_session`)).toEqual([])

        yield* store.apply(segment(3, [event("late", 1)]), projector)
        expect(yield* database.all(sql`SELECT id FROM projection_session`)).toEqual([])
        yield* store.apply(deletion, projector)
        expect(yield* store.cursor(remote)).toBe(3)

        yield* store.delete(tombstone, 30)
        yield* store.enqueue(event("stale-local", 2), 30)
        expect(yield* store.pending(10)).toEqual([])
        const local = yield* store.seal(device, 10, 31)
        expect(local?.operations).toEqual([{ kind: "tombstone", tombstone }])
      }),
    )
  })

  test("treats a replayed tombstone timestamp as equivalent", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const deleted: string[] = []
        const projector: SyncEvent.DurableProjector = {
          project: () => Effect.void,
          delete: (item) => Effect.sync(() => void deleted.push(item.sessionID)),
        }
        const first = SyncEvent.Tombstone.make({ id: "delete-a", sessionID: "session-a", deletedAt: 20 })
        const replay = SyncEvent.Tombstone.make({ ...first, deletedAt: 30 })
        const deletion = (generation: number, tombstone: SyncEvent.Tombstone) =>
          SyncEvent.Segment.make({
            version: 1,
            id: SyncEvent.SegmentID.make(`${remote}:${generation}`),
            deviceID: remote,
            generation,
            createdAt: tombstone.deletedAt,
            operations: [{ kind: "tombstone", tombstone }],
          })

        yield* store.applyDurable(deletion(1, first), projector)
        yield* store.applyDurable(deletion(2, replay), projector)

        expect(yield* store.cursor(remote)).toBe(2)
        expect(deleted).toEqual(["session-a", "session-a"])
      }),
    )
  })

  test("treats legacy ISO and encoded location timestamps as equivalent", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const projector: SyncEvent.DurableProjector = { project: () => Effect.void, delete: () => Effect.void }
        const legacy = SyncEvent.Envelope.make({
          id: "location",
          aggregateID: "session-a",
          seq: 0,
          type: "session.next.location.rebound.1",
          data: { timestamp: "2026-09-08T19:02:18.875Z" },
        })
        const encoded = SyncEvent.Envelope.make({ ...legacy, data: { timestamp: 1_788_894_138_875 } })

        yield* store.applyDurable(segment(1, [legacy]), projector)
        yield* store.applyDurable(segment(2, [encoded]), projector)

        expect(yield* store.cursor(remote)).toBe(2)
      }),
    )
  })

  test("absorbs advertised deletions before stale local events can be sealed", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const tombstone = SyncEvent.Tombstone.make({ id: "remote-delete", sessionID: "session-a", deletedAt: 20 })
        let projections = 0
        const projector: SyncEvent.DurableProjector = {
          project: () => Effect.void,
          delete: () => Effect.sync(() => void projections++),
        }
        yield* store.enqueue(event("stale-local", 0), 10)
        yield* store.absorbDeletions([tombstone], projector)
        expect(yield* store.pending(10)).toEqual([])
        expect(yield* store.seal(device, 10)).toBeUndefined()
        expect(yield* store.deletions()).toEqual([tombstone])

        // Reapplying the projection is intentional crash recovery across the
        // sync and Session databases; delete implementations are idempotent.
        yield* store.absorbDeletions([tombstone], projector)
        expect(projections).toBe(2)
      }),
    )
  })

  test("recovers a cross-database projection crash before advancing its cursor", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        const projected = new Set<string>()
        const attempts = new Map<string, number>()
        let fail = true
        const projector: SyncEvent.DurableProjector = {
          project: (item) =>
            Effect.gen(function* () {
              // Models EventV2's durable event-ID idempotency in the Session DB.
              attempts.set(item.id, (attempts.get(item.id) ?? 0) + 1)
              projected.add(item.id)
              if (item.id === "two" && fail) return yield* Effect.fail("simulated process crash")
            }),
          delete: () => Effect.void,
        }
        const remoteSegment = segment(1, [event("one", 0), event("two", 1)])
        const crashed = yield* store.applyDurable(remoteSegment, projector).pipe(Effect.exit)
        expect(Exit.isFailure(crashed)).toBe(true)
        expect(yield* store.cursor(remote)).toBe(0)
        expect(yield* store.pendingApply()).toEqual([remoteSegment])
        expect([...projected].sort()).toEqual(["one", "two"])

        fail = false
        yield* store.applyDurable(remoteSegment, projector)
        expect(yield* store.cursor(remote)).toBe(1)
        expect(yield* store.pendingApply()).toEqual([])
        expect([...projected].sort()).toEqual(["one", "two"])
        expect(Object.fromEntries(attempts)).toEqual({ one: 2, two: 2 })
      }),
    )
  })

  test("coordinates a renewable cross-process lease by owner and expiry", async () => {
    await run(
      Effect.gen(function* () {
        const store = yield* SyncEventStore.Service
        expect(yield* store.acquire("pull", "process-a", 100, 1_000)).toBe(true)
        expect(yield* store.acquire("pull", "process-b", 100, 1_050)).toBe(false)
        expect(yield* store.renew("pull", "process-b", 100, 1_050)).toBe(false)
        expect(yield* store.renew("pull", "process-a", 100, 1_050)).toBe(true)
        expect(yield* store.acquire("pull", "process-b", 100, 1_120)).toBe(false)
        expect(yield* store.acquire("pull", "process-b", 100, 1_151)).toBe(true)
        yield* store.release("pull", "process-a")
        expect(yield* store.acquire("pull", "process-c", 100, 1_160)).toBe(false)
        yield* store.release("pull", "process-b")
        expect(yield* store.acquire("pull", "process-c", 100, 1_160)).toBe(true)
      }),
    )
  })

  test("persists lease exclusion across independent processes", async () => {
    await using tmp = await tmpdir()
    const filename = path.join(tmp.path, "sync.db")
    const worker = path.join(import.meta.dir, "fixture", "sync-lease-worker.ts")
    const runWorker = async (owner: string, now: number) => {
      const child = Bun.spawn([process.execPath, worker, filename, owner, String(now)], {
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exit, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect(exit, stderr).toBe(0)
      return JSON.parse(stdout) as { acquired: boolean }
    }
    expect(await runWorker("first", 1_000)).toEqual({ acquired: true })
    expect(await runWorker("second", 1_050)).toEqual({ acquired: false })
    expect(await runWorker("second", 1_101)).toEqual({ acquired: true })
  })
})
