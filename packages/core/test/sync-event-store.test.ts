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
    raw.run("CREATE TABLE sync_event_outbox (event_id TEXT PRIMARY KEY, segment_id TEXT, created_at INTEGER)")
    raw.run("CREATE TABLE sync_event_segment (id TEXT PRIMARY KEY, device_id TEXT, generation INTEGER)")
    raw.run("CREATE TABLE sync_event_head (device_id TEXT PRIMARY KEY)")
    raw.run("CREATE TABLE sync_event_cursor (device_id TEXT PRIMARY KEY)")
    raw.run("CREATE TABLE sync_remote_segment (device_id TEXT, generation INTEGER)")
    raw.run("CREATE TABLE sync_remote_event (device_id TEXT, event_id TEXT)")
    raw.run("CREATE TABLE sync_deletion_set (session_id TEXT PRIMARY KEY)")
    raw.close()
    const database = SyncDatabase.layerFromPath(filename)
    const version = await Effect.runPromise(
      Effect.gen(function* () {
        const { db } = yield* SyncDatabase.Service
        return yield* db.get<{ version: number }>(sql`SELECT MAX(version) AS version FROM sync_schema`)
      }).pipe(Effect.scoped, Effect.provide(database)),
    )
    expect(version).toEqual({ version: 5 })
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

  test("partitions pending events, cursors, and leases by sync space", async () => {
    await run(
      Effect.gen(function* () {
        const root = yield* SyncEventStore.Service
        const first = root.scope("space-a")
        const second = root.scope("space-b")
        yield* first.enqueue(event("space-a-event", 0))
        yield* second.enqueue({ ...event("space-b-event", 0), aggregateID: "session-b" })
        expect((yield* first.pending(10)).map((item) => item.id)).toEqual(["space-a-event"])
        expect((yield* second.pending(10)).map((item) => item.id)).toEqual(["space-b-event"])
        expect(yield* first.acquire("upload", "first", 1_000, 0)).toBe(true)
        expect(yield* second.acquire("upload", "second", 1_000, 0)).toBe(true)
        const sealed = yield* first.seal(device, 10, 10)
        expect(sealed?.operations).toHaveLength(1)
        expect(yield* second.seal(SyncEvent.DeviceID.make("device-space-b"), 10, 10)).toBeDefined()
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
