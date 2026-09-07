import { describe, expect, test } from "bun:test"
import { defineCommand, type InvocationContext, type ResolutionDiagnostic } from "@opencode-ai/command-kit"
import {
  createCommandHost,
  normalizeCommandRestrictions,
  resolveUpstreamCandidates,
} from "../../src/command-toolkit/host"
import { adaptKeymapCommands, adaptServerCommands } from "../../src/command-toolkit/upstream"

const context: InvocationContext = {
  source: "slash",
  client: "tui",
  abortSignal: new AbortController().signal,
  confirm: async () => true,
}

describe("Home and Session command host integration", () => {
  test("autocomplete, direct submit, and palette share the Core winner identity", async () => {
    const calls: string[] = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.sync.settings",
            path: ["sync"],
            title: "Sync settings",
            description: "Manage Session sync",
            provenance: { type: "core", feature: "cloud-sync" },
            capabilities: ["sync.configure"],
            parse: (raw) => ({ status: "parsed", input: raw.value }),
            execute: async (_ctx, value) => {
              calls.push(value)
              return { status: "completed" }
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => [],
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.slashes()[0]).toMatchObject({ identity: "fork.sync.settings", provenance: { type: "core" } })
    expect(host.commands()[0]).toMatchObject({ name: "fork.sync.settings", commandKitIdentity: "fork.sync.settings" })
    expect(await host("/sync now")).toMatchObject({ status: "handled", identity: "fork.sync.settings" })
    await host.commands()[0]!.run()
    host.slashes()[0]!.onSelect?.()
    await Promise.resolve()
    expect(calls).toEqual(["now", "", ""])
  })

  test("server command remains upstream-first and keeps resolver-owned raw arguments", async () => {
    let coreRan = false
    const diagnostics: ResolutionDiagnostic[] = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.environment.init",
            path: ["env", "init"],
            title: "Environment init",
            provenance: { type: "core", feature: "environment" },
            capabilities: ["workspace.write"],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => {
              coreRan = true
              return { status: "completed" }
            },
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => adaptServerCommands([{ name: "env", source: "command" }]),
      invalid: () => undefined,
      outcome: () => undefined,
      diagnostic: (item) => diagnostics.push(item),
    })

    expect(await host("/env   init  保留\nsecond")).toMatchObject({
      status: "session",
      identity: "session.command:env",
      command: "env",
      arguments: "init  保留\nsecond",
    })
    expect(coreRan).toBe(false)
    expect(diagnostics).toHaveLength(1)
    expect(host.slashes().find((item) => item.display === "/env init")).toMatchObject({
      identity: "session.command:env",
      insertText: "/env init ",
      shadowed: [expect.objectContaining({ type: "shadowed" })],
    })
  })

  test("legacy keymap command keeps its handler and identity outside Core policy", async () => {
    const dispatched: string[] = []
    const entries = [
      {
        command: {
          name: "plugin.deploy",
          title: "Deploy",
          desc: "Plugin action",
          slashName: "deploy",
          // Arbitrary plugin metadata cannot masquerade as the host's private Core marker.
          commandKitIdentity: "fork.deploy",
        },
      },
    ]
    const upstream = adaptKeymapCommands(entries, (identity) => dispatched.push(identity))
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.deploy",
            path: ["deploy"],
            title: "Core deploy",
            provenance: { type: "core", feature: "fixture" },
            capabilities: ["workspace.write"],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => ({ status: "completed" }),
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => upstream,
      restrictions: () => ({ disabled: ["plugin.deploy"], deniedCapabilities: ["workspace.write"] }),
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.slashes()[0]).toMatchObject({ identity: "plugin.deploy", provenance: { type: "upstream" } })
    const direct = await host("/deploy release")
    expect(direct).toMatchObject({ status: "handled", identity: "plugin.deploy" })
    expect(resolveUpstreamCandidates("/deploy", upstream)[0]?.id).toBe("plugin.deploy")
    expect(host.commands()[0]).toMatchObject({ name: "fork.deploy", commandKitPath: ["deploy"] })
    expect(dispatched).toEqual(["plugin.deploy"])
  })

  test("normalizes persisted user restrictions without granting capabilities", () => {
    expect(
      normalizeCommandRestrictions({
        disabled: ["fork.sync.settings", 1],
        hidden: "not-an-array",
        confirm: ["fork.target.manage"],
        deniedCapabilities: ["sync.configure", false],
        grantedCapabilities: ["workspace.write"],
      }),
    ).toEqual({
      disabled: ["fork.sync.settings"],
      hidden: undefined,
      confirm: ["fork.target.manage"],
      deniedCapabilities: ["sync.configure"],
    })
  })
})
