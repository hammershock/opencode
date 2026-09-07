import { describe, expect, test } from "bun:test"
import { defineCommand, type InvocationContext } from "@opencode-ai/command-kit"
import { createCommandHost } from "../../src/command-toolkit/host"

const context: InvocationContext = {
  source: "slash",
  client: "tui",
  abortSignal: new AbortController().signal,
  confirm: async () => true,
}

describe("TUI command toolkit host", () => {
  test("executes a registered core command", async () => {
    const calls: string[] = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.test.run",
            path: ["test"],
            title: "test",
            provenance: { type: "core", feature: "test" },
            capabilities: [],
            parse: (raw) => ({ status: "parsed", input: raw.value }),
            execute: async (_ctx, value) => {
              calls.push(value)
              return { status: "completed", message: "done" }
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => undefined,
      invalid: () => undefined,
      outcome: (message) => calls.push(message),
    })
    expect(await host("/test value")).toBe(true)
    expect(calls).toEqual(["value", "done"])
    expect(host.commands()).toEqual([
      expect.objectContaining({ name: "fork.test.run", slashName: "test", title: "test" }),
    ])
    await host.commands()[0]!.run()
    expect(calls).toEqual(["value", "done", "", "done"])
  })

  test("preserves upstream-first compatibility", async () => {
    let ran = false
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.test.run",
            path: ["test"],
            title: "test",
            provenance: { type: "core", feature: "test" },
            capabilities: [],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => {
              ran = true
              return { status: "completed" }
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => ({
        id: "upstream.test",
        path: ["test"],
        provenance: { type: "upstream", host: "tui", identity: "test" },
      }),
      invalid: () => undefined,
      outcome: () => undefined,
    })
    expect(await host("/test")).toBe(false)
    expect(ran).toBe(false)
  })

  test("turns command service failures into host feedback", async () => {
    const outcomes: string[] = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.test.fail",
            path: ["fail"],
            title: "fail",
            provenance: { type: "core", feature: "test" },
            capabilities: [],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => {
              throw new Error("service unavailable")
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => undefined,
      invalid: () => undefined,
      outcome: (message, status) => outcomes.push(`${status}:${message}`),
    })
    expect(await host("/fail")).toBe(true)
    expect(outcomes).toEqual(["failed:service unavailable"])
  })
})
