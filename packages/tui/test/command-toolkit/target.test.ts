import { describe, expect, test } from "bun:test"
import { targetCommand, type TargetCommandContext } from "../../src/command-toolkit/target"
import { createCommandHost } from "../../src/command-toolkit/host"

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

  test.each(["home", "session"])("is discoverable and directly invokable from the %s host", async (route) => {
    const opened: string[] = []
    const host = createCommandHost<TargetCommandContext>({
      register: (registry) => registry.register(targetCommand),
      context: (source) => ({
        source,
        client: "tui",
        ...(route === "session" ? { sessionID: "ses_test" } : {}),
        abortSignal: new AbortController().signal,
        confirm: async () => false,
        openTargetManager: (mode) => opened.push(mode),
      }),
      upstream: () => undefined,
      invalid: () => undefined,
      outcome: () => undefined,
    })
    expect(host.registrations()).toEqual([expect.objectContaining({ name: "fork.target.manage", slashName: "target" })])
    expect(host.registrations()[0]?.enabled()).toBe(true)
    expect(await host("/target add")).toMatchObject({ status: "handled", identity: "fork.target.manage" })
    await host.registrations()[0]!.run()
    expect(opened).toEqual(["add", "manage"])
  })
})
