import { describe, expect, test } from "bun:test"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"

describe("HTTP server sync capture graph", () => {
  test("includes the SessionSync capture node", () => {
    expect(HttpApiApp.app.dependencies).toContain(SessionSync.node)
  })
})
