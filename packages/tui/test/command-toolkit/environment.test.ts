import { describe, expect, test } from "bun:test"
import { CommandRegistry } from "@opencode-ai/command-kit"
import { environmentCommands, type EnvironmentCommandContext } from "../../src/command-toolkit/environment"

const raw = { source: "/env init", value: "", range: { start: 9, end: 9 } }

function context(overrides: Partial<EnvironmentCommandContext> = {}): EnvironmentCommandContext {
  return {
    source: "slash",
    client: "tui",
    sessionID: "session",
    location: {},
    abortSignal: new AbortController().signal,
    confirm: async () => true,
    environment: {
      list: async () => ({ enabled: true, generation: 1, variables: [] }),
      reload: async () => ({ enabled: true, generation: 2, variables: [] }),
      reveal: async () => ({ generation: 1, values: {} }),
      init: async () => ({ status: "completed", template: "created", generation: 2 }),
    },
    presentEnvironment: async () => {},
    ...overrides,
  }
}

describe("environment command toolkit", () => {
  test("registers canonical env routes", () => {
    const registry = new CommandRegistry<EnvironmentCommandContext>()
    environmentCommands.forEach((command) => registry.register(command))
    expect(registry.routes().map((route) => route.path.join(" "))).toEqual(["env list", "env reload", "env init"])
  })

  test("init presents the Core workflow outcome", async () => {
    let calls = 0
    const init = environmentCommands[2]
    const prepared = init.parse(raw)
    expect(prepared.status).toBe("parsed")
    const cancelled = await init.execute(
      context({
        environment: {
          list: async () => ({ enabled: true, generation: 1, variables: [] }),
          reload: async () => ({ enabled: true, generation: 2, variables: [] }),
          reveal: async () => ({ generation: 1, values: {} }),
          init: async () => {
            calls++
            return { status: "cancelled", template: "existing" }
          },
        },
      }),
      undefined,
    )
    expect(cancelled).toEqual({ status: "cancelled", message: "Environment was not reloaded" })
    const result = await init.execute(
      context({
        environment: {
          list: async () => ({ enabled: true, generation: 1, variables: [] }),
          reload: async () => ({ enabled: true, generation: 2, variables: [] }),
          reveal: async () => ({ generation: 1, values: {} }),
          init: async () => {
            calls++
            return { status: "completed", template: "created", generation: 3 }
          },
        },
      }),
      undefined,
    )
    expect(result).toEqual({ status: "completed", message: "Created .env and loaded generation 3" })
    expect(calls).toBe(2)
  })
})
