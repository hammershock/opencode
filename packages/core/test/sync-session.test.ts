import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventSequenceTable, EventTable } from "@opencode-ai/core/event/sql"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { SessionTable } from "@opencode-ai/core/session/sql"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { SyncOwnership } from "@opencode-ai/core/sync/ownership"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { Session } from "@opencode-ai/schema/session"
import { SessionV1 } from "@opencode-ai/schema/session-v1"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { eq } from "drizzle-orm"
import path from "node:path"
import { tmpdir } from "./fixture/tmpdir"

describe("SessionSync", () => {
  test("backfills assigned V1 Session history into its target space", async () => {
    await using tmp = await tmpdir()
    const layer = LayerNode.compile(LayerNode.group([Database.node, SyncEventStore.node, SyncOwnership.node]), [
      [Database.node, Database.layerFromPath(path.join(tmp.path, "session.db"))],
      [SyncDatabase.node, SyncDatabase.layerFromPath(path.join(tmp.path, "sync.db"))],
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const database = (yield* Database.Service).db
        const store = yield* SyncEventStore.Service
        const ownership = yield* SyncOwnership.Service
        const sessionID = Session.ID.make("ses_legacy_backfill")
        const messageID = SessionV1.MessageID.ascending("msg_legacy_backfill")
        // Reproduce rows committed by the still-supported V1 Session endpoint;
        // startup recovery reads this durable fact source without republishing it.
        yield* database.insert(EventSequenceTable).values({ aggregate_id: sessionID, seq: 2 }).run()
        yield* database
          .insert(EventTable)
          .values([
            {
              id: EventV2.ID.create(),
              aggregate_id: sessionID,
              seq: 0,
              type: "session.created.1",
              data: {
                sessionID,
                info: {
                  id: sessionID,
                  slug: "legacy",
                  projectID: "global",
                  directory: "/project",
                  title: "Legacy Session",
                  version: "test",
                  time: { created: 0, updated: 0 },
                },
              },
            },
            {
              id: EventV2.ID.create(),
              aggregate_id: sessionID,
              seq: 1,
              type: "message.updated.1",
              data: {
                sessionID,
                info: {
                  id: messageID,
                  sessionID,
                  role: "user",
                  time: { created: 1 },
                  agent: "build",
                  model: { providerID: "test", modelID: "test" },
                },
              },
            },
            {
              id: EventV2.ID.create(),
              aggregate_id: sessionID,
              seq: 2,
              type: "message.part.updated.1",
              data: {
                sessionID,
                part: {
                  id: SessionV1.PartID.ascending("prt_legacy_backfill"),
                  sessionID,
                  messageID,
                  type: "text",
                  text: "legacy history",
                },
                time: 2,
              },
            },
          ])
          .run()
        yield* ownership.assign(sessionID, "target-space", 1)
        yield* Effect.forEach(
          yield* ownership.list(),
          (item) => SessionSync.backfill(database, store, item.sessionID, item.spaceID),
          { discard: true },
        )

        const pending = yield* store.scope("target-space").pending(10)
        expect(pending.map((event) => event.type).toSorted()).toEqual([
          "message.part.updated.1",
          "message.updated.1",
          "session.created.1",
        ])
        expect(new Set(pending.map((event) => event.aggregateID))).toEqual(new Set([sessionID]))
        expect(yield* store.pending(10)).toEqual([])
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })

  test("includes foreign durable history only when rebuilding a new cloud root", async () => {
    await using tmp = await tmpdir()
    const layer = LayerNode.compile(LayerNode.group([Database.node, SyncEventStore.node, SyncOwnership.node]), [
      [Database.node, Database.layerFromPath(path.join(tmp.path, "session.db"))],
      [SyncDatabase.node, SyncDatabase.layerFromPath(path.join(tmp.path, "sync.db"))],
    ])

    await Effect.runPromise(
      Effect.gen(function* () {
        const database = (yield* Database.Service).db
        const store = yield* SyncEventStore.Service
        const sessionID = Session.ID.make("ses_foreign_rebuild")
        yield* database
          .insert(EventSequenceTable)
          .values({ aggregate_id: sessionID, seq: 0, owner_id: "device-remote" })
          .run()
        yield* database
          .insert(EventTable)
          .values({
            id: EventV2.ID.create(),
            aggregate_id: sessionID,
            seq: 0,
            type: "session.created.1",
            data: {
              sessionID,
              info: {
                id: sessionID,
                slug: "foreign",
                projectID: "global",
                directory: "/project",
                title: "Foreign Session",
                version: "test",
                time: { created: 0, updated: 0 },
              },
            },
          })
          .run()

        yield* SessionSync.backfill(database, store, sessionID, "joined-cloud")
        expect(yield* store.scope("joined-cloud").pending(10)).toEqual([])

        yield* SessionSync.backfill(database, store, sessionID, "new-cloud", { includeForeignHistory: true })
        expect((yield* store.scope("new-cloud").pending(10)).map((event) => event.type)).toEqual(["session.created.1"])
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })

  test("keeps the application available when startup recovery fails", async () => {
    const layer = SessionSync.captureLayer.pipe(
      Layer.provide([
        Layer.mock(EventV2.Service, {
          all: () => Stream.empty,
          listen: () => Effect.succeed(Effect.void),
        }),
        Layer.mock(SyncEventStore.Service, {
          scope: () => {
            throw new Error("unexpected scoped store access")
          },
        }),
        Layer.mock(SyncOwnership.Service, {
          assign: () => Effect.void,
          unassign: () => Effect.void,
          list: () => Effect.fail(new Error("recovery unavailable")),
        }),
        Layer.mock(SessionActivity.Service, {
          blockers: () => Effect.succeed([]),
        }),
        Layer.mock(Database.Service, {
          db: {
            select: () => ({ from: () => ({ all: () => Effect.succeed([]) }) }),
          } as unknown as Database.Interface["db"],
        }),
      ]),
    )

    const exit = await Effect.runPromiseExit(Layer.build(layer).pipe(Effect.scoped))

    expect(Exit.isSuccess(exit)).toBe(true)
  })

  test("repairs ownership from surviving rows without discarding deleted Session routing", async () => {
    const ownership = new Map([
      ["explicitly-local", "old-space"],
      ["moved", "old-space"],
      ["deleted", "delete-space"],
    ])
    await Effect.runPromise(
      SessionSync.reconcileOwnership(
        {
          assign: (sessionID, spaceID) => Effect.sync(() => void ownership.set(sessionID, spaceID)),
          unassign: (sessionID) => Effect.sync(() => void ownership.delete(sessionID)),
        },
        [
          { sessionID: "explicitly-local", assignedAt: 1 },
          { sessionID: "moved", spaceID: "new-space", assignedAt: 2 },
          { sessionID: "new", spaceID: "new-space", assignedAt: 3 },
        ],
      ),
    )
    expect(Object.fromEntries(ownership)).toEqual({
      moved: "new-space",
      deleted: "delete-space",
      new: "new-space",
    })
  })

  test("routes only owned Session events to their original space", async () => {
    const spaces: string[] = []
    const enqueued: string[] = []
    const ownership = new Map<string, string>()
    const store = {
      scope: (spaceID: string) => {
        spaces.push(spaceID)
        return store
      },
      enqueue: (event: SyncEvent.Envelope) => Effect.sync(() => void enqueued.push(event.aggregateID)),
      delete: () => Effect.void,
    } as any
    const owner = {
      assign: (sessionID: string, spaceID: string) => Effect.sync(() => void ownership.set(sessionID, spaceID)),
      get: (sessionID: string) =>
        Effect.succeed(ownership.get(sessionID) ? { spaceID: ownership.get(sessionID)! } : undefined),
    }
    const event = (sessionID: string, type: string, data: Record<string, unknown>) => ({
      id: `${sessionID}-${type}`,
      type,
      durable: { aggregateID: sessionID, seq: type === "session.created" ? 0 : 1, version: 1 },
      data,
    })

    await Effect.runPromise(
      SessionSync.captureOwned(owner as any, store, event("owned", "session.created", { info: { syncSpaceID: "a" } })),
    )
    await Effect.runPromise(SessionSync.captureOwned(owner as any, store, event("owned", "session.updated", {})))
    await Effect.runPromise(SessionSync.captureOwned(owner as any, store, event("local", "session.updated", {})))

    expect(spaces).toEqual(["a", "a"])
    expect(enqueued).toEqual(["owned", "owned"])
  })

  test("an explicit persisted unassignment overrides stale ownership but a deleted row still routes its tombstone", async () => {
    const spaces: string[] = []
    const deleted: string[] = []
    const store = {
      scope: (spaceID: string) => {
        spaces.push(spaceID)
        return store
      },
      enqueue: () => Effect.void,
      delete: (value: SyncEvent.Tombstone) => Effect.sync(() => void deleted.push(value.sessionID)),
    } as any
    const owner = {
      assign: () => Effect.void,
      get: () => Effect.succeed({ spaceID: "old-space" }),
    }
    const updated = {
      id: "updated",
      type: "session.updated",
      durable: { aggregateID: "session", seq: 2, version: 1 },
      data: { sessionID: "session" },
    }
    await Effect.runPromise(
      SessionSync.captureOwned(owner as any, store, updated, 10, () => Effect.succeed({ exists: true } as const)),
    )
    expect(spaces).toEqual([])

    await Effect.runPromise(
      SessionSync.captureOwned(
        owner as any,
        store,
        { ...updated, id: "deleted", type: "session.deleted", durable: { ...updated.durable, seq: 3 } },
        11,
        () => Effect.succeed({ exists: false } as const),
      ),
    )
    expect(spaces).toEqual(["old-space"])
    expect(deleted).toEqual(["session"])
  })

  test("captures ordinary durable events and maps deletion to a permanent tombstone", async () => {
    const calls: any[] = []
    const store = {
      enqueue: (event: unknown) => Effect.sync(() => void calls.push(["event", event])),
      delete: (event: unknown) => Effect.sync(() => void calls.push(["delete", event])),
    } as any
    await Effect.runPromise(
      SessionSync.capture(
        store,
        {
          id: "e1",
          type: "session.updated",
          durable: { aggregateID: "s1", seq: 2, version: 1 },
          data: { sessionID: "s1", omitted: undefined },
        },
        10,
      ),
    )
    await Effect.runPromise(
      SessionSync.capture(
        store,
        {
          id: "e2",
          type: "session.deleted",
          durable: { aggregateID: "s1", seq: 3, version: 1 },
          data: { sessionID: "s1" },
        },
        11,
      ),
    )
    expect(calls[0]).toMatchObject([
      "event",
      { id: "e1", aggregateID: "s1", seq: 2, type: "session.updated.1", data: { sessionID: "s1" } },
    ])
    expect(calls[1]).toMatchObject(["delete", { id: "e2", sessionID: "s1", deletedAt: 11 }])
  })

  test("normalizes durable Session timestamps on capture and historical replay", async () => {
    const captured: any[] = []
    const store = {
      enqueue: (event: unknown) => Effect.sync(() => void captured.push(event)),
      delete: () => Effect.void,
    } as any
    const instant = new Date("2026-09-09T18:18:26.247Z")
    await Effect.runPromise(
      SessionSync.capture(store, {
        id: "timestamp-capture",
        type: "session.next.prompt.admitted",
        durable: { aggregateID: "s1", seq: 1, version: 1 },
        data: { sessionID: "s1", timestamp: instant },
      }),
    )
    expect(captured[0].data.timestamp).toBe(instant.getTime())

    const replayed: any[] = []
    const projector = SessionSync.projector({
      replay: (event: unknown) => Effect.sync(() => void replayed.push(event)),
      remove: () => Effect.void,
    } as any)
    await Effect.runPromise(
      projector.project({
        id: EventV2.ID.create(),
        aggregateID: "s1",
        seq: 1,
        type: "session.next.prompt.admitted.1",
        data: { sessionID: "s1", timestamp: instant.toISOString() },
      }),
    )
    expect(replayed[0].data.timestamp).toBe(instant.getTime())
  })

  test("hydrates through EventV2 replay and removes deleted aggregates", async () => {
    const calls: unknown[] = []
    const events = {
      replay: (event: unknown, options: unknown) => Effect.sync(() => void calls.push(["replay", event, options])),
      remove: (id: string) => Effect.sync(() => void calls.push(["remove", id])),
    } as any
    const projector = SessionSync.projector(events)
    await Effect.runPromise(
      projector.project({
        id: "evt_00000000000000000000000000",
        aggregateID: "s1",
        seq: 0,
        type: "session.created",
        data: {},
      }),
    )
    await Effect.runPromise(projector.delete({ id: "d1", sessionID: "s1", deletedAt: 1 }))
    expect(calls[0]).toMatchObject([
      "replay",
      { id: "evt_00000000000000000000000000", aggregateID: "s1", seq: 0 },
      { publish: true },
    ])
    expect(calls[1]).toEqual(["remove", "s1"])
  })

  test("hydrates the complete frozen model context body and order", async () => {
    await using tmp = await tmpdir()
    const layer = LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionProjector.node]), [
      [Database.node, Database.layerFromPath(path.join(tmp.path, "session.db"))],
    ])
    const sessionID = Session.ID.make("ses_context_hydrate")
    const environment = ModelContext.Environment.make({
      harness: "OpenCode REXD",
      entrypoint: "opencode-rexd",
      targetKind: "rexd",
      targetName: "mywindows",
      directory: "/home/hammer/project",
      projectRoot: "/home/hammer/project",
      vcs: "git",
      platform: "linux",
    })
    const instructions = ModelContext.Instructions.make([
      {
        id: "global",
        origin: "global-file",
        scope: "global",
        source: "/controller/AGENTS.md",
        status: "loaded",
        content: "controller rules",
        digest: "digest-global",
      },
      {
        id: "project",
        origin: "project-file",
        scope: "project",
        source: "/home/hammer/project/AGENTS.md",
        status: "loaded",
        content: "target rules",
        digest: "digest-project",
      },
    ])
    const context = ModelContext.Generation.make({
      version: 1,
      generation: 1,
      reason: "created",
      locationRevision: 0,
      environment,
      instructions,
      digest: "digest-generation",
      baseline: "frozen model context",
      sources: {
        [ModelContext.Key.make("core/environment")]: { value: environment, baseline: "environment" },
        [ModelContext.Key.make("core/instructions")]: {
          value: instructions,
          baseline: "controller rules\ntarget rules",
        },
      },
    })

    await Effect.runPromise(
      Effect.gen(function* () {
        const events = yield* EventV2.Service
        const database = (yield* Database.Service).db
        const projector = SessionSync.projector(events)
        yield* projector.project({
          id: EventV2.ID.create(),
          aggregateID: sessionID,
          seq: 0,
          type: "session.created.1",
          data: {
            sessionID,
            info: {
              id: sessionID,
              slug: "context-hydrate",
              projectID: "global",
              directory: "/home/hammer/project",
              title: "Context hydrate",
              version: "test",
              time: { created: 1, updated: 1 },
            },
          },
        })
        yield* projector.project({
          id: EventV2.ID.create(),
          aggregateID: sessionID,
          seq: 1,
          type: "session.next.context.generation.established.1",
          data: { sessionID, timestamp: 2, context },
        })

        const hydrated = yield* SessionContextEpoch.inspect(database, sessionID)
        expect(hydrated).toEqual(context)
        expect(hydrated?.instructions.map((item) => item.content)).toEqual(["controller rules", "target rules"])
      }).pipe(Effect.scoped, Effect.provide(layer)),
    )
  })

  test("records remote Location rebind sequence without changing this device Location", async () => {
    const calls: any[] = []
    const events = {
      replay: (event: unknown, options: unknown) => Effect.sync(() => void calls.push([event, options])),
      remove: () => Effect.void,
    } as any
    const projector = SessionSync.projector(events, SyncEvent.DeviceID.make("remote"))

    await Effect.runPromise(
      projector.project({
        id: EventV2.ID.create(),
        aggregateID: "ses_device_local_location",
        seq: 4,
        type: "session.next.location.rebound.1",
        data: {
          sessionID: "ses_device_local_location",
          timestamp: 1,
          previous: { target: { type: "local" }, directory: "/remote/old" },
          location: { target: { type: "local" }, directory: "/remote/new" },
          revision: 1,
        },
      }),
    )

    expect(calls[0]?.[1]).toMatchObject({
      ownerID: "remote",
      allowForeignAppend: true,
      publish: false,
      project: false,
    })
  })

  test("persists real versioned Created ownership across restart reconciliation", async () => {
    await using tmp = await tmpdir()
    const sessionPath = path.join(tmp.path, "session.db")
    const syncPath = path.join(tmp.path, "sync.db")
    const layer = () =>
      LayerNode.compile(LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SyncOwnership.node]), [
        [Database.node, Database.layerFromPath(sessionPath)],
        [SyncDatabase.node, SyncDatabase.layerFromPath(syncPath)],
      ])
    const sessionID = Session.ID.make("ses_remote_owned")
    const spaceID = "remote-space-exact"

    await Effect.runPromise(
      Effect.gen(function* () {
        const database = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const ownership = yield* SyncOwnership.Service
        const projector = SessionSync.projector(
          events,
          undefined,
          undefined,
          undefined,
          undefined,
          spaceID,
          (id, ownedSpaceID) => ownership.assign(id, ownedSpaceID),
        )
        yield* projector.project({
          id: EventV2.ID.create(),
          aggregateID: sessionID,
          seq: 0,
          type: "session.created.1",
          data: {
            sessionID,
            info: {
              id: sessionID,
              slug: "remote-owned",
              projectID: "global",
              directory: "/remote/project",
              title: "Remote owned Session",
              version: "test",
              time: { created: 1, updated: 1 },
            },
          },
        })

        expect(
          yield* database
            .select({ spaceID: SessionTable.sync_space_id })
            .from(SessionTable)
            .where(eq(SessionTable.id, sessionID))
            .get(),
        ).toEqual({ spaceID })
        expect(yield* ownership.get(sessionID)).toMatchObject({ sessionID, spaceID })
      }).pipe(Effect.scoped, Effect.provide(layer())),
    )

    await Effect.runPromise(
      Effect.gen(function* () {
        const database = (yield* Database.Service).db
        const ownership = yield* SyncOwnership.Service
        const row = yield* database
          .select({ sessionID: SessionTable.id, spaceID: SessionTable.sync_space_id })
          .from(SessionTable)
          .where(eq(SessionTable.id, sessionID))
          .get()
        expect(row).toEqual({ sessionID, spaceID })
        yield* SessionSync.reconcileOwnership(ownership, [{ sessionID, spaceID: row!.spaceID!, assignedAt: 1 }])
        expect(yield* ownership.get(sessionID)).toMatchObject({ sessionID, spaceID })
      }).pipe(Effect.scoped, Effect.provide(layer())),
    )
  })

  test("does not bind unsupported or non-Created durable wire events", async () => {
    const replayed: SyncEvent.Envelope[] = []
    const owned: string[] = []
    const projector = SessionSync.projector(
      {
        replay: (event: SyncEvent.Envelope) => Effect.sync(() => void replayed.push(event)),
        remove: () => Effect.void,
      } as any,
      undefined,
      undefined,
      undefined,
      undefined,
      "remote-space",
      (sessionID) => Effect.sync(() => void owned.push(sessionID)),
    )
    const event = (type: string) => ({
      id: EventV2.ID.create(),
      aggregateID: `ses_${type}`,
      seq: 0,
      type,
      data: { info: { syncSpaceID: "sender-value" } },
    })

    await Effect.runPromise(projector.project(event("session.updated.1")))
    await Effect.runPromise(projector.project(event("session.created.999")))

    expect(replayed.map((item) => item.data)).toEqual([
      { info: { syncSpaceID: "sender-value" } },
      { info: { syncSpaceID: "sender-value" } },
    ])
    expect(owned).toEqual([])
  })

  test("marks projection and deletion as sync replay activity", async () => {
    const calls: string[] = []
    const activity = {
      blockers: () => Effect.succeed([]),
      withActivity: (sessionID: string, kind: string, effect: Effect.Effect<unknown>) =>
        Effect.acquireUseRelease(
          Effect.sync(() => calls.push(`start:${sessionID}:${kind}`)),
          () => effect,
          () => Effect.sync(() => calls.push(`end:${sessionID}:${kind}`)),
        ),
    } as any
    const events = {
      replay: () => Effect.sync(() => calls.push("replay")),
      remove: () => Effect.sync(() => calls.push("remove")),
    } as any
    const projector = SessionSync.projector(
      events,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      activity,
    )

    await Effect.runPromise(
      projector.project({
        id: "evt_00000000000000000000000000",
        aggregateID: "ses_sync_activity",
        seq: 0,
        type: "session.created",
        data: {},
      }),
    )
    await Effect.runPromise(projector.delete({ id: "d1", sessionID: "ses_sync_activity", deletedAt: 1 }))

    expect(calls).toEqual([
      "start:ses_sync_activity:sync_replay",
      "replay",
      "end:ses_sync_activity:sync_replay",
      "start:ses_sync_activity:sync_replay",
      "remove",
      "end:ses_sync_activity:sync_replay",
    ])
  })

  test("materializes a deterministic sibling when a remote history diverges", async () => {
    const calls: any[] = []
    const events = {
      replay: (event: any, options: any) => {
        calls.push([event, options])
        if (event.aggregateID === "s1" && event.seq === 1)
          return Effect.die(
            new EventV2.InvalidDurableEventError({
              type: event.type,
              message: "Replay diverged at aggregate s1 sequence 1",
            }),
          )
        return Effect.void
      },
      durable: () =>
        Stream.make({
          id: EventV2.ID.create(),
          type: "session.created",
          durable: { aggregateID: "s1", seq: 0, version: 1 },
          data: { id: "s1", sessionID: "s1" },
        }),
      remove: () => Effect.void,
    } as any
    const projector = SessionSync.projector(events, SyncEvent.DeviceID.make("remote"))
    await Effect.runPromise(
      projector.project({
        id: EventV2.ID.create(),
        aggregateID: "s1",
        seq: 1,
        type: "session.updated",
        data: { sessionID: "s1", title: "remote" },
      }),
    )
    const sibling = calls[1][0].aggregateID as string
    expect(sibling).toMatch(/^s1-conflict-/)
    expect(calls[1][0].data).toMatchObject({ id: sibling, sessionID: sibling })
    expect(calls[2][0]).toMatchObject({ aggregateID: sibling, seq: 1, data: { sessionID: sibling } })
    expect(calls[1][1]).toMatchObject({ ownerID: "remote", strictOwner: true, allowEquivalent: true })
    expect(calls[2][1]).toMatchObject({ ownerID: "remote", strictOwner: true, allowEquivalent: true })
  })

  test("replays attachment-backed Session parts only after restoring their data URL", async () => {
    const blobs = new Map<string, Uint8Array>()
    const attachment = {
      put: async (value: Uint8Array) => {
        blobs.set("image", value)
        return "image"
      },
      get: async (id: string) => blobs.get(id)!,
    }
    const wire = await SessionSync.externalize(
      {
        id: "evt_00000000000000000000000001",
        aggregateID: "s1",
        seq: 0,
        type: "session.part.updated",
        data: { part: { type: "file", url: "data:image/png;base64,aGVsbG8=" } },
      },
      attachment,
    )
    expect(JSON.stringify(wire)).not.toContain("aGVsbG8=")
    const calls: any[] = []
    const projector = SessionSync.projector(
      { replay: (event: unknown) => Effect.sync(() => void calls.push(event)), remove: () => Effect.void } as any,
      undefined,
      undefined,
      attachment,
    )
    await Effect.runPromise(projector.project(wire))
    expect(calls[0].data.part.url).toBe("data:image/png;base64,aGVsbG8=")
  })
})
