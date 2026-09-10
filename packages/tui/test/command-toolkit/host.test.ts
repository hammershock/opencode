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
            readOnly: false,
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
    expect(host.registrations()).toEqual([
      expect.objectContaining({ name: "fork.test.run", slashName: "test", title: "test" }),
    ])
    await host.registrations()[0]!.run()
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
            readOnly: false,
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
    expect(host.registrations()[0]).toMatchObject({
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
            readOnly: false,
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

  test("rejects an unknown leading slash command without echoing its input", async () => {
    const invalid: string[] = []
    const host = createCommandHost({
      register: () => undefined,
      context: (source) => ({ ...context, source }),
      upstream: () => undefined,
      invalid: (message) => invalid.push(message),
      outcome: () => undefined,
    })

    expect(await host("/MISSING --token synthetic-secret")).toEqual({
      status: "invalid",
      message: "Slash command does not exist",
      diagnostics: [],
    })
    expect(await host(" /MISSING --token synthetic-secret")).toEqual({
      status: "passthrough",
      input: " /MISSING --token synthetic-secret",
      diagnostics: [],
    })
    expect(await host("explain /MISSING")).toEqual({
      status: "passthrough",
      input: "explain /MISSING",
      diagnostics: [],
    })
    expect(invalid).toEqual(["Slash command does not exist"])
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
            readOnly: false,
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
    expect(host.registrations()[0]?.enabled()).toBe(false)
  })

  test("only executes commands marked safe in a read-only Session", async () => {
    const calls: string[] = []
    const invalid: string[] = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.test.inspect",
            path: ["inspect"],
            title: "inspect",
            provenance: { type: "core", feature: "test" },
            readOnly: true,
            capabilities: [],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => {
              calls.push("inspect")
              return { status: "completed" }
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => [
        {
          id: "app.exit",
          path: ["exit"],
          aliases: [["quit"], ["q"]],
          title: "Exit",
          readOnly: true,
          provenance: { type: "upstream", host: "tui", identity: "app.exit" },
          dispatch: { type: "client", run: () => calls.push("exit") },
        },
        {
          id: "plugin.deploy",
          path: ["deploy"],
          title: "Deploy",
          provenance: { type: "plugin", pluginID: "fixture" },
          dispatch: { type: "client", run: () => calls.push("deploy") },
        },
      ],
      readOnly: () => true,
      invalid: (message) => invalid.push(message),
      outcome: () => undefined,
    })

    expect(await host("/inspect")).toMatchObject({ status: "handled", identity: "fork.test.inspect" })
    expect(await host("/exit")).toMatchObject({ status: "handled", identity: "app.exit" })
    expect(await host("/quit")).toMatchObject({ status: "handled", identity: "app.exit" })
    expect(await host("/q")).toMatchObject({ status: "handled", identity: "app.exit" })
    expect(await host("/deploy")).toEqual({
      status: "invalid",
      message: "Current Session is read-only",
      diagnostics: [],
    })
    expect(calls).toEqual(["inspect", "exit", "exit", "exit"])
    expect(invalid).toEqual(["Current Session is read-only"])
    expect(host.commands().find((command) => command.identity === "plugin.deploy")?.enabled).toBe(false)
    expect(host.slashes().map((command) => command.display)).toEqual(["/exit", "/inspect", "/q", "/quit"])
  })
})
