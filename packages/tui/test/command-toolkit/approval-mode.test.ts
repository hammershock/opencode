import { describe, expect, test } from "bun:test"
import { CommandRegistry, createHostResolver } from "@opencode-ai/command-kit"
import { approvalModeCommand, type ApprovalModeCommandContext } from "../../src/command-toolkit/approval-mode"
import { permissionModeActions } from "../../src/component/dialog-permission-mode"
import type { PermissionMode } from "../../src/context/permission"

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
      approvalMode: {
        open: () => {
          opened++
        },
      },
    })
    expect(opened).toBe(1)
  })

  test("shows both durable scopes and changes each independently", async () => {
    let defaultMode: PermissionMode = "normal"
    let sessionMode: PermissionMode = "auto"
    const actions = () =>
      permissionModeActions({
        defaultMode,
        sessionMode,
        setDefault: (mode) => {
          defaultMode = mode
        },
        setSession: (mode) => {
          sessionMode = mode
        },
      })

    expect(actions().map((item) => [item.value, item.title, item.description])).toEqual([
      ["default", "Default · Enable auto-approve", "Currently normal · copied only to new Sessions"],
      ["session", "Session · Disable auto-approve", "Currently auto · changes only this durable Session"],
    ])
    await actions()[0]!.run()
    expect(String(defaultMode)).toBe("auto")
    expect(String(sessionMode)).toBe("auto")
    await actions()[1]!.run()
    expect(String(defaultMode)).toBe("auto")
    expect(String(sessionMode)).toBe("normal")
  })
})
