import { describe, expect, test } from "bun:test"
import { targetCommand, type TargetCommandContext } from "../../src/command-toolkit/target"

const raw = (value: string) => ({ source: `/target ${value}`, value, range: { start: 8, end: 8 + value.length } })

describe("target command", () => {
  test("opens management without mutating session location", async () => {
    const opened: string[] = []
    const ctx: TargetCommandContext = {
      source: "slash",
      client: "tui",
      sessionID: "session-1",
      location: { target: { type: "rexd", targetID: "unchanged" }, directory: "/work" },
      abortSignal: new AbortController().signal,
      confirm: async () => true,
      targetManagerEnabled: true,
      openTargetManager: (mode) => opened.push(mode),
    }
    const parsed = targetCommand.parse(raw("add"))
    expect(parsed.status).toBe("parsed")
    if (parsed.status !== "parsed") return
    expect(await targetCommand.execute(ctx, parsed.input)).toEqual({ status: "completed" })
    expect(opened).toEqual(["add"])
    expect(ctx.location).toEqual({ target: { type: "rexd", targetID: "unchanged" }, directory: "/work" })
  })

  test("rejects unsupported switching syntax", () => {
    expect(targetCommand.parse(raw("use target-2"))).toMatchObject({
      status: "invalid",
      code: "invalid_target_action",
    })
  })
})
