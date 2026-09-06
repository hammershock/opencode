import { describe, expect, test } from "bun:test"
import { SyncConflict } from "@opencode-ai/core/sync/conflict"
import { SyncEvent } from "@opencode-ai/core/sync/event"

const event = (id: string, data: string): SyncEvent.Envelope =>
  SyncEvent.Envelope.make({ id, aggregateID: "session", seq: 1, type: "message", data: { data } })

describe("SyncConflict", () => {
  test("owner wins and sibling ID converges regardless of pull order", async () => {
    const a = { deviceID: SyncEvent.DeviceID.make("a"), event: event("a-event", "a") }
    const b = { deviceID: SyncEvent.DeviceID.make("b"), event: event("b-event", "b") }
    const forward = await SyncConflict.mergeEvents([a, b], { owners: { session: "b" } })
    const reverse = await SyncConflict.mergeEvents([b, a], { owners: { session: "b" } })
    expect(forward).toEqual(reverse)
    expect(forward.main[0]).toEqual(b)
    expect(forward.siblings[0]?.source).toEqual(a)
  })

  test("tombstones dominate every event and metadata revisions use stable device tie-break", async () => {
    const a = { deviceID: SyncEvent.DeviceID.make("a"), event: event("a-event", "a") }
    expect((await SyncConflict.mergeEvents([a], { owners: {}, deleted: new Set(["session"]) })).main).toEqual([])
    const base = { sessionID: "session", title: "A", ownerDeviceID: "a", directory: "/a", revision: 2, updatedAt: 1 }
    const winner = { ...base, title: "B", directory: "/b" }
    expect(
      SyncConflict.mergeMetadata([
        { deviceID: "z", value: base },
        { deviceID: "a", value: winner },
      ]),
    ).toEqual([winner])
  })
})
