import { describe, expect, test } from "bun:test"
import { CommandRegistry } from "@opencode-ai/command-kit"
import {
  environmentCommands,
  revealEnvironment,
  type EnvironmentCommandContext,
} from "../../src/command-toolkit/environment"

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
      ensureTemplate: async () => "created",
    },
    presentEnvironment: async () => {},
    invokeAgent: async () => "completed",
    ...overrides,
  }
}

describe("environment command toolkit", () => {
  test("registers canonical env routes", () => {
    const registry = new CommandRegistry<EnvironmentCommandContext>()
    environmentCommands.forEach((command) => registry.register(command))
    expect(registry.routes().map((route) => route.path.join(" "))).toEqual(["env list", "env reload", "env init"])
  })

  test("init reloads only after the agent completes", async () => {
    let reloads = 0
    const init = environmentCommands[2]
    const prepared = init.parse(raw)
    expect(prepared.status).toBe("parsed")
    await init.execute(
      context({
        environment: {
          list: async () => ({ enabled: true, generation: 1, variables: [] }),
          reload: async () => {
            reloads++
            return { enabled: true, generation: 2, variables: [] }
          },
          reveal: async () => ({ generation: 1, values: {} }),
          ensureTemplate: async () => "existing",
        },
        invokeAgent: async () => "cancelled",
      }),
      undefined,
    )
    expect(reloads).toBe(0)
    const result = await init.execute(
      context({
        environment: {
          list: async () => ({ enabled: true, generation: 1, variables: [] }),
          reload: async () => {
            reloads++
            return { enabled: true, generation: 2, variables: [] }
          },
          reveal: async () => ({ generation: 1, values: {} }),
          ensureTemplate: async () => "created",
        },
      }),
      undefined,
    )
    expect(result.status).toBe("completed")
    expect(reloads).toBe(1)
  })

  test("init waits for the exact admitted Agent turn before reloading", async () => {
    let finish!: (value: "completed") => void
    const turn = new Promise<"completed">((resolve) => (finish = resolve))
    let reloads = 0
    const execution = environmentCommands[2].execute(
      context({
        invokeAgent: () => turn,
        environment: {
          list: async () => ({ enabled: true, generation: 1, variables: [] }),
          reload: async () => {
            reloads++
            return { enabled: true, generation: 2, variables: [] }
          },
          reveal: async () => ({ generation: 1, values: {} }),
          ensureTemplate: async () => "existing",
        },
      }),
      undefined,
    )
    await Promise.resolve()
    expect(reloads).toBe(0)
    finish("completed")
    await execution
    expect(reloads).toBe(1)
  })

  test("reveal requires confirmation and clears values after presentation", async () => {
    let requests = 0
    const denied = await revealEnvironment({
      confirm: async () => false,
      reveal: async () => {
        requests++
        return { generation: 1, values: { SECRET: "hidden" } }
      },
      present: async () => {},
    })
    expect(denied).toBeFalse()
    expect(requests).toBe(0)

    const snapshot: { generation: number; values: Record<string, string> } = {
      generation: 1,
      values: { SECRET: "hidden" },
    }
    await revealEnvironment({
      confirm: async () => true,
      reveal: async () => snapshot,
      present: async (current) => expect(current.values.SECRET).toBe("hidden"),
    })
    expect(snapshot.values).toEqual({})
  })
})
