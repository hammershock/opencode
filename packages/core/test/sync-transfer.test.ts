import { describe, expect, test } from "bun:test"
import { SyncTransfer } from "@opencode-ai/core/sync/transfer"
import type { SyncTransferEvent } from "@opencode-ai/schema/sync-transfer-event"

describe("SyncTransfer", () => {
  test("stays silent without effective transfer and clears after progress", async () => {
    const events: SyncTransferEvent.Progress[] = []
    const transfer = SyncTransfer.make(async (progress) => void events.push(progress))

    await transfer.finish()
    expect(events).toEqual([])

    await transfer.start("upload", "sessions")
    await transfer.complete("upload", "sessions", 1_500)
    await transfer.complete("upload", "sessions", 500)
    await transfer.start("download", "attachments")
    await transfer.complete("download", "attachments", 4_096)
    await transfer.finish()

    expect(events).toEqual([
      { state: "active", direction: "upload", phase: "sessions" },
      { state: "active", direction: "upload", phase: "sessions", items: 1, bytes: 1_500 },
      { state: "active", direction: "upload", phase: "sessions", items: 2, bytes: 2_000 },
      { state: "active", direction: "download", phase: "attachments" },
      { state: "active", direction: "download", phase: "attachments", items: 1, bytes: 4_096 },
      { state: "idle" },
    ])
  })

  test("does not let an observer failure change sync behavior", async () => {
    const transfer = SyncTransfer.make(async () => {
      throw new Error("listener unavailable")
    })

    await expect(transfer.start("upload", "sessions")).resolves.toBeUndefined()
    await expect(transfer.complete("upload", "sessions", 10)).resolves.toBeUndefined()
    await expect(transfer.finish()).resolves.toBeUndefined()
  })
})
