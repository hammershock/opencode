import { describe, expect, test } from "bun:test"
import { CommandRegistry, createHostResolver } from "@opencode-ai/command-kit"
import { sessionControlCommands, type SessionControlCommandContext } from "../../src/command-toolkit/session-controls"

function setup(result: "deleted" | "cancelled" = "deleted") {
  const calls: string[] = []
  const registry = new CommandRegistry<SessionControlCommandContext>()
  sessionControlCommands.forEach((command) => registry.register(command))
  const context: SessionControlCommandContext = {
    source: "slash",
    client: "tui",
    sessionID: "session-1",
    location: { directory: "/workspace" },
    abortSignal: new AbortController().signal,
    confirm: async () => true,
    sessionControls: {
      outputExpansion: (expanded) => calls.push(expanded ? "expand" : "collapse"),
      delete: async () => {
        calls.push("delete")
        return result
      },
    },
  }
  return { calls, context, resolve: createHostResolver(registry.routes(), () => undefined) }
}

describe("session control commands", () => {
  test.each([
    ["/expand", "expand"],
    ["/collapse", "collapse"],
    ["/delete", "delete"],
  ])("executes %s without invoking an Agent", async (source, expected) => {
    const fixture = setup()
    const resolution = fixture.resolve(source)
    expect(resolution.status).toBe("core")
    if (resolution.status !== "core") return
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    expect(prepared.status).toBe("parsed")
    if (prepared.status !== "parsed") return
    await prepared.execute(fixture.context)
    expect(fixture.calls).toEqual([expected])
  })

  test("preserves cancellation from the delete domain request", async () => {
    const fixture = setup("cancelled")
    const resolution = fixture.resolve("/delete")
    if (resolution.status !== "core") throw new Error("command was not resolved")
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    if (prepared.status !== "parsed") throw new Error("command was not prepared")
    expect(await prepared.execute(fixture.context)).toEqual({ status: "cancelled" })
    expect(fixture.calls).toEqual(["delete"])
  })
})
