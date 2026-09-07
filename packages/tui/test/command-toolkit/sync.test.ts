import { describe, expect, test } from "bun:test"
import { CommandRegistry } from "@opencode-ai/command-kit"
import { syncCommands, type SyncCommandContext } from "../../src/command-toolkit/sync"

describe("sync command toolkit", () => {
  test("routes root sync and devices through the shared settings controller", async () => {
    const opened: string[] = []
    const context: SyncCommandContext = {
      source: "slash",
      client: "tui",
      abortSignal: new AbortController().signal,
      confirm: async () => true,
      openSyncSettings: async (view) => {
        opened.push(view)
        return "completed"
      },
    }
    const registry = new CommandRegistry<SyncCommandContext>()
    syncCommands.forEach((command) => registry.register(command))

    expect(registry.routes().map((route) => route.path.join(" "))).toEqual(["sync", "devices"])
    expect(await syncCommands[0].execute(context, undefined)).toMatchObject({ status: "completed" })
    expect(await syncCommands[1].execute(context, undefined)).toMatchObject({ status: "completed" })
    expect(opened).toEqual(["overview", "devices"])
  })

  test("rejects arguments before opening settings", () => {
    expect(
      syncCommands[0].parse({
        source: "/sync unexpected",
        value: "unexpected",
        range: { start: 6, end: 16 },
      }).status,
    ).toBe("invalid")
  })
})
