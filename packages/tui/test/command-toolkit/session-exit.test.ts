import { describe, expect, test } from "bun:test"
import { installSessionExitOverride } from "../../src/command-toolkit/session-exit"
import type { OverrideWarning } from "@opencode-ai/command-kit"

function fixture(enabled: boolean, home?: () => void) {
  const warnings: OverrideWarning[] = []
  const calls: string[] = []
  const override = installSessionExitOverride({
    enabled,
    exit: () => {
      calls.push("exit")
    },
    home:
      home ??
      (() => {
        calls.push("home")
      }),
    warning: (warning) => warnings.push(warning),
  })
  return { calls, warnings, override }
}

describe("session exit override", () => {
  test("preserves upstream exit on every route while disabled", async () => {
    const item = fixture(false)
    await item.override.execute({ route: "session" })
    await item.override.execute({ route: "home" })
    expect(item.calls).toEqual(["exit", "exit"])
  })

  test("returns only /exit from a Session to QuickStart", async () => {
    const item = fixture(true)
    await item.override.execute({ route: "session" })
    await item.override.execute({ route: "home" })
    await item.override.execute({ route: "other" })
    expect(item.calls).toEqual(["home", "exit", "exit"])
  })

  test("falls back atomically to upstream exit when navigation fails", async () => {
    const item = fixture(true, () => {
      throw new Error("route unavailable")
    })
    await item.override.execute({ route: "session" })
    expect(item.calls).toEqual(["exit"])
    expect(item.warnings).toEqual([
      expect.objectContaining({
        overrideID: "fork.session.exit-to-home",
        upstreamIdentity: "app.exit",
        phase: "apply",
      }),
    ])
  })
})
