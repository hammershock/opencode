import { describe, expect, test } from "bun:test"
import { installSessionRenameOverride, parseSessionRenameArguments } from "../../src/command-toolkit/session-rename"
import type { OverrideWarning } from "@opencode-ai/command-kit"

describe("session rename override", () => {
  test("parses resolver-owned arguments and rejects multiline titles", () => {
    expect(parseSessionRenameArguments("Project α")).toEqual({
      status: "parsed",
      input: { title: "Project α" },
    })
    expect(parseSessionRenameArguments("first\nsecond")).toEqual({
      status: "invalid",
      message: "Session titles must be a single line",
    })
  })

  test("uses the upstream dialog behavior while disabled", async () => {
    const calls: string[] = []
    const override = installSessionRenameOverride({
      enabled: false,
      upstream: async () => {
        calls.push("dialog")
      },
      rename: async (title) => {
        calls.push(`rename:${title}`)
      },
      warning: () => {},
    })

    await override.execute({ title: "New title" })
    expect(calls).toEqual(["dialog"])
  })

  test("keeps the dialog for empty input and directly renames a trimmed single-line title", async () => {
    const calls: string[] = []
    const override = installSessionRenameOverride({
      enabled: true,
      upstream: async () => {
        calls.push("dialog")
      },
      rename: async (title) => {
        calls.push(`rename:${title}`)
      },
      warning: () => {},
    })

    await override.execute({ title: "  " })
    await override.execute({ title: "  新标题 with spaces  " })
    expect(calls).toEqual(["dialog", "rename:新标题 with spaces"])
  })

  test("falls back without removing rename when runtime application is unavailable", async () => {
    const calls: string[] = []
    const warnings: OverrideWarning[] = []
    const override = installSessionRenameOverride({
      enabled: true,
      upstream: async () => {
        calls.push("dialog")
      },
      rename: async () => {
        throw new Error("transport unavailable")
      },
      warning: (warning) => warnings.push(warning),
    })

    await override.execute({ title: "valid title" })
    expect(calls).toEqual(["dialog"])
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "upstream-override-fallback",
        overrideID: "fork.session.rename-direct",
        upstreamIdentity: "session.rename",
        phase: "apply",
      }),
    ])
  })
})
