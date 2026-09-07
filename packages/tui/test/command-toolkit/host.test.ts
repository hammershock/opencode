import { describe, expect, test } from "bun:test"
import { defineCommand, type InvocationContext, type ResolutionDiagnostic } from "@opencode-ai/command-kit"
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
    expect(await host("/test value")).toMatchObject({ status: "handled", identity: "fork.test.run" })
    expect(calls).toEqual(["value", "done"])
    expect(host.commands()).toEqual([
      expect.objectContaining({ name: "fork.test.run", slashName: "test", title: "test" }),
    ])
    await host.commands()[0]!.run()
    expect(calls).toEqual(["value", "done", "", "done"])
  })

  test("preserves upstream-first compatibility", async () => {
    let ran = false
    const upstream: string[] = []
    const diagnostics: ResolutionDiagnostic[] = []
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
        title: "upstream test",
        provenance: { type: "upstream", host: "tui", identity: "test" },
        dispatch: { type: "client", run: (rawArguments: string) => upstream.push(rawArguments) },
      }),
      invalid: () => undefined,
      outcome: () => undefined,
      diagnostic: (item) => diagnostics.push(item),
    })
    expect(await host("/test value")).toMatchObject({ status: "handled", identity: "upstream.test" })
    expect(ran).toBe(false)
    expect(upstream).toEqual(["value"])
    expect(diagnostics).toHaveLength(1)
    expect(host.diagnostics()).toEqual(diagnostics)
    expect(host.commands()[0]).toMatchObject({
      name: "fork.test.run",
      commandKitPath: ["test"],
    })
    expect(host.slashes()[0]).toMatchObject({ identity: "upstream.test", provenance: { type: "upstream" } })
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
    expect(await host("/fail")).toMatchObject({ status: "handled", identity: "fork.test.fail" })
    expect(outcomes).toEqual(["failed:service unavailable"])
  })

  test("rejects a restricted capability before command side effects", async () => {
    let ran = false
    const outcomes: string[] = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.test.write",
            path: ["write"],
            title: "write",
            provenance: { type: "core", feature: "test" },
            capabilities: ["workspace.write"],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => {
              ran = true
              return { status: "completed" }
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => [],
      restrictions: () => ({ deniedCapabilities: ["workspace.write"] }),
      invalid: () => undefined,
      outcome: (message, status) => outcomes.push(`${status}:${message}`),
    })
    expect(await host("/write")).toMatchObject({ status: "handled", identity: "fork.test.write" })
    expect(ran).toBe(false)
    expect(outcomes).toEqual(["failed:Capability denied by user policy: workspace.write"])
    expect(host.commands()[0]?.enabled()).toBe(false)
  })
})
