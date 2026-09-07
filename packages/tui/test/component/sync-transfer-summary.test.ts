import { describe, expect, test } from "bun:test"
import { syncTransferSummary } from "../../src/component/sync-transfer-summary"

describe("syncTransferSummary", () => {
  test("keeps active transfer text compact and omits unknown counts", () => {
    expect(syncTransferSummary({ state: "active", direction: "upload", phase: "sessions" })).toBe("◐ ↑ sessions")
    expect(
      syncTransferSummary({
        state: "active",
        direction: "download",
        phase: "attachments",
        items: 3,
        bytes: 1_536,
      }),
    ).toBe("◐ ↓ attachments · 3 · 1.5 KB")
  })
})
