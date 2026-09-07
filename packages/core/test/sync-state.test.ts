import { describe, expect, test } from "bun:test"
import { SyncState } from "@opencode-ai/core/sync/state"
import { tmpdir } from "./fixture/tmpdir"

const descriptor = {
  namespaceID: "space-a",
  name: "Research",
  protocol: { major: 1 as const, minor: 0 },
  encryption: "none" as const,
  createdAt: 1,
  updatedAt: 1,
  summary: { sessions: 0, devices: 0, updatedAt: 1 },
  revision: 1,
}

describe("SyncState", () => {
  test("keeps one active space without changing ownership of other spaces", async () => {
    const state = SyncState.empty("Mac", "device")
    const connected = { ...state, account: { id: "account", maskedDisplay: "h•••• · ••••1234" } }
    const joined = SyncState.bind(connected, {
      accountID: "account",
      descriptor,
      remoteRoot: "/apps/opencode-sync/spaces/space-a",
      joinedAt: 2,
    })
    expect(SyncState.active(SyncState.activate(joined, "space-a"))?.namespaceID).toBe("space-a")
    expect(() =>
      SyncState.bind(joined, {
        accountID: "account",
        descriptor: { ...descriptor, encryption: "aes-256-gcm" },
        remoteRoot: "/apps/opencode-sync/spaces/space-a",
        joinedAt: 3,
      }),
    ).toThrow(SyncState.ConflictError)
  })

  test("uses optimistic revisions for atomic config replacement", async () => {
    await using tmp = await tmpdir()
    const store = SyncState.make(tmp.path)
    const first = await store.write(SyncState.empty("Mac", "device"))
    const second = await store.update((value) => ({ ...value, enabled: false }), first.revision)
    expect(second.revision).toBe(first.revision + 1)
    await expect(store.write({ ...second, enabled: true }, first.revision)).rejects.toBeInstanceOf(
      SyncState.ConflictError,
    )
  })
})
