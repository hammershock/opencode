import { describe, expect, test } from "bun:test"
import { Effect, Exit, Layer, Stream } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { SyncOwnership } from "@opencode-ai/core/sync/ownership"
import { SessionSync } from "@opencode-ai/core/sync/session"

describe("SessionSync", () => {
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
    const calls: unknown[] = []
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
    expect(calls[2][1]).toMatchObject({ ownerID: "remote", strictOwner: true })
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
