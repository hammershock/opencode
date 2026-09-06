import { describe, expect, test } from "bun:test"
import { defineUpstreamCommand, installUpstreamOverride, verifyUpstreamCommand, type OverrideWarning } from "../src"

const baseline = defineUpstreamCommand(
  {
    identity: "session.rename",
    host: "tui.session",
    path: ["rename"],
    aliases: [],
    title: "Rename session",
    category: "Session",
    availability: "session-route",
    inputBoundary: "no-arguments",
  },
  "337fd144d2ba:session.rename:v1",
)

const target = verifyUpstreamCommand(baseline, baseline)

describe("upstream override", () => {
  test("does not install when its independent experimental setting is disabled", async () => {
    const installed = installUpstreamOverride({
      definition: definition(() => async () => ({ status: "handled", value: "fork" })),
      enabled: false,
      upstream: async () => "upstream",
      warning: () => {
        throw new Error("disabled overrides must not warn")
      },
    })

    expect(await installed.execute("name")).toBe("upstream")
    expect(installed.diagnostic()).toEqual({ status: "disabled" })
  })

  test("installs a verified decorator atomically", async () => {
    const installed = installUpstreamOverride({
      definition: definition(() => async (title) => ({ status: "handled", value: `fork:${title}` })),
      enabled: true,
      upstream: async (title) => `upstream:${title}`,
      warning: () => {},
    })

    expect(await installed.execute("name")).toBe("fork:name")
    expect(installed.diagnostic()).toEqual({ status: "active" })
  })

  test.each(["install", "apply"] as const)("keeps upstream behavior and warns after %s failure", async (phase) => {
    const warnings: OverrideWarning[] = []
    const installed = installUpstreamOverride({
      definition: definition(() => {
        if (phase === "install") throw new Error("dependency missing")
        return async () => ({ status: "unavailable", reason: "route detached" })
      }),
      enabled: true,
      upstream: async (title) => `upstream:${title}`,
      warning: (warning) => warnings.push(warning),
    })

    expect(await installed.execute("name")).toBe("upstream:name")
    expect(warnings).toEqual([
      expect.objectContaining({
        type: "upstream-override-fallback",
        overrideID: "fork.session.rename-direct",
        upstreamIdentity: "session.rename",
        phase,
      }),
    ])
    expect(installed.diagnostic()).toEqual({ status: "fallback", warning: warnings[0]! })
    expect(await installed.execute("again")).toBe("upstream:again")
    expect(warnings).toHaveLength(1)
  })
})

function definition(
  decorate: (
    next: (input: string) => Promise<string>,
  ) => (input: string) => Promise<{ status: "handled"; value: string } | { status: "unavailable"; reason: string }>,
) {
  return {
    id: "fork.session.rename-direct",
    target,
    experimentalSetting: "commands.renameDirect",
    decorate,
  }
}
