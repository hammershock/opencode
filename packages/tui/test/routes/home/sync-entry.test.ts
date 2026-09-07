import { describe, expect, test } from "bun:test"
import { openQuickStartSync } from "../../../src/routes/home"

describe("QuickStart sync entry", () => {
  test("opens the shared Sync Settings overview", async () => {
    const opened: string[] = []
    await openQuickStartSync(async (view) => {
      opened.push(view)
    })

    expect(opened).toEqual(["overview"])
  })
})
