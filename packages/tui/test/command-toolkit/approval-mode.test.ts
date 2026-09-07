import { describe, expect, test } from "bun:test"
import { CommandRegistry, createHostResolver } from "@opencode-ai/command-kit"
import { approvalModeCommand, type ApprovalModeCommandContext } from "../../src/command-toolkit/approval-mode"

describe("approval mode command", () => {
  test("opens the contextual two-state approval control", async () => {
    let opened = 0
    const registry = new CommandRegistry<ApprovalModeCommandContext>()
    registry.register(approvalModeCommand)
    const resolution = createHostResolver(registry.routes(), () => undefined)("/permissions")
    expect(resolution.status).toBe("core")
    if (resolution.status !== "core") return
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    expect(prepared.status).toBe("parsed")
    if (prepared.status !== "parsed") return
    await prepared.execute({
      source: "slash",
      client: "tui",
      abortSignal: new AbortController().signal,
      confirm: async () => false,
      approvalMode: { open: () => opened++ },
    })
    expect(opened).toBe(1)
  })
})
