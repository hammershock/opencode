import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SessionSync } from "@opencode-ai/core/sync/session"

describe("SessionSync", () => {
  test("captures ordinary durable events and maps deletion to a permanent tombstone", async () => {
    const calls: unknown[] = []
    const store = {
      enqueue: (event: unknown) => Effect.sync(() => void calls.push(["event", event])),
      delete: (event: unknown) => Effect.sync(() => void calls.push(["delete", event])),
    } as any
    await Effect.runPromise(
      SessionSync.capture(
        store,
        { id: "e1", type: "session.updated", durable: { aggregateID: "s1", seq: 2 }, data: { sessionID: "s1" } },
        10,
      ),
    )
    await Effect.runPromise(
      SessionSync.capture(
        store,
        { id: "e2", type: "session.deleted", durable: { aggregateID: "s1", seq: 3 }, data: { sessionID: "s1" } },
        11,
      ),
    )
    expect(calls[0]).toMatchObject(["event", { id: "e1", aggregateID: "s1", seq: 2 }])
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
      projector.project(
        {} as any,
        {
          id: "evt_00000000000000000000000000",
          aggregateID: "s1",
          seq: 0,
          type: "session.created",
          data: {},
        },
      ),
    )
    await Effect.runPromise(projector.delete({} as any, { id: "d1", sessionID: "s1", deletedAt: 1 }))
    expect(calls[0]).toMatchObject([
      "replay",
      { id: "evt_00000000000000000000000000", aggregateID: "s1", seq: 0 },
      { publish: true },
    ])
    expect(calls[1]).toEqual(["remove", "s1"])
  })
})
