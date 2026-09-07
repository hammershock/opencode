import { describe, expect, test } from "bun:test"
import { SyncSpace } from "@opencode-ai/core/sync/space"

const descriptor = (namespaceID: string, revision: number): SyncSpace.Descriptor => ({
  namespaceID,
  name: namespaceID,
  protocol: { major: 1, minor: 0 },
  encryption: "none",
  createdAt: 1,
  updatedAt: revision,
  summary: { sessions: 0, devices: 0, updatedAt: revision },
  revision,
})

describe("SyncSpace", () => {
  test("keeps global deletion dominant over stale descriptors", () => {
    const initial = SyncSpace.put(SyncSpace.empty(), descriptor("space", 1))
    const deleted = SyncSpace.remove(initial, "space", 3)
    expect(SyncSpace.merge(deleted, initial).spaces).toEqual([])
    expect(SyncSpace.merge(deleted, initial).deletions).toHaveLength(1)
  })

  test("never allows a deleted namespace ID to be reused", () => {
    const deleted = SyncSpace.remove(SyncSpace.put(SyncSpace.empty(), descriptor("space", 1)), "space", 3)
    expect(() => SyncSpace.put(deleted, descriptor("space", deleted.revision + 1))).toThrow()
  })

  test("blocks unsupported protocol versions", () => {
    expect(SyncSpace.compatible({ major: 1, minor: 0 })).toBe(true)
    expect(SyncSpace.compatible({ major: 1, minor: 1 })).toBe(false)
  })
})
