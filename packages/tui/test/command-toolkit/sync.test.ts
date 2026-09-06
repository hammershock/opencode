import { describe, expect, test } from "bun:test"
import { CommandRegistry } from "@opencode-ai/command-kit"
import { syncCommands, type SyncCommandContext } from "../../src/command-toolkit/sync"

describe("sync command toolkit", () => {
  test("routes /sync setup through the trusted setup capability", async () => {
    let opened = 0
    const context = {
      source: "slash",
      client: "tui",
      abortSignal: new AbortController().signal,
      confirm: async () => true,
      openSyncSetup: async () => {
        opened++
        return "completed" as const
      },
    } as SyncCommandContext
    const registry = new CommandRegistry<SyncCommandContext>()
    syncCommands.forEach((command) => registry.register(command))

    expect(registry.routes().map((route) => route.path.join(" "))).toEqual(["sync setup"])
    const parsed = syncCommands[0].parse({ source: "/sync setup", value: "", range: { start: 11, end: 11 } })
    expect(parsed.status).toBe("parsed")
    const result = await syncCommands[0].execute(context, undefined)
    expect(result.status).toBe("completed")
    expect(opened).toBe(1)
  })

  test("rejects arguments before opening the wizard", async () => {
    let opened = false
    const result = syncCommands[0].parse({
      source: "/sync setup unexpected",
      value: "unexpected",
      range: { start: 12, end: 22 },
    })
    expect(result.status).toBe("invalid")
    expect(opened).toBe(false)
  })
})
