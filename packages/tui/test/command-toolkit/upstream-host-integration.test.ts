import { describe, expect, test } from "bun:test"
import { defineCommand, type InvocationContext, type ResolutionDiagnostic } from "@opencode-ai/command-kit"
import {
  createCommandHost,
  normalizeCommandRestrictions,
  resolveUpstreamCandidates,
} from "../../src/command-toolkit/host"
import { adaptKeymapCommands, adaptServerCommands } from "../../src/command-toolkit/upstream"
import { commandPaletteWinners } from "../../src/command-toolkit/palette"

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
            readOnly: false,
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
    expect(host.commands()[0]).toMatchObject({ identity: "fork.sync.settings", provenance: { type: "core" } })
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
            readOnly: false,
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
            readOnly: false,
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
    expect(upstream[0]?.readOnly).toBe(false)
    const direct = await host("/deploy release")
    expect(direct).toMatchObject({ status: "handled", identity: "plugin.deploy" })
    expect(resolveUpstreamCandidates("/deploy", upstream)[0]?.id).toBe("plugin.deploy")
    expect(host.registrations()[0]).toMatchObject({ name: "fork.deploy", commandKitPath: ["deploy"] })
    expect(dispatched).toEqual(["plugin.deploy"])
  })

  test("shows reviewed upstream purpose and provenance in slash and palette surfaces", () => {
    const host = createCommandHost({
      register: () => undefined,
      context: (source) => ({ ...context, source }),
      upstream: () =>
        adaptKeymapCommands(
          [
            {
              command: {
                name: "session.list",
                title: "Switch session",
                desc: "Search and open a session",
                slashName: "sessions",
                readOnly: true,
              },
            },
          ],
          () => undefined,
        ),
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.slashes()[0]?.description).toBe("Search and open a session · upstream")
    expect(host.slashes()[0]?.readOnly).toBe(true)
    expect(commandPaletteWinners(host.commands())[0]?.description).toBe("Search and open a session · upstream")
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

  test("updates every host surface when a dynamic upstream collision appears", async () => {
    let upstream: ReturnType<typeof adaptServerCommands> = []
    const host = createCommandHost({
      register: (registry) =>
        registry.register(
          defineCommand({
            id: "fork.dynamic",
            path: ["dynamic"],
            title: "Core dynamic",
            provenance: { type: "core", feature: "fixture" },
            readOnly: false,
            capabilities: [],
            parse: () => ({ status: "parsed", input: undefined }),
            execute: async () => ({ status: "completed" }),
          }),
        ),
      context: (source) => ({ ...context, source }),
      upstream: () => upstream,
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.commands()[0]?.identity).toBe("fork.dynamic")
    expect(host.slashes()[0]?.identity).toBe("fork.dynamic")
    expect(commandPaletteWinners(host.commands())[0]?.identity).toBe("fork.dynamic")
    expect(await host("/dynamic")).toMatchObject({ identity: "fork.dynamic" })

    upstream = adaptServerCommands([{ name: "dynamic", source: "mcp", provenance: { type: "mcp", serverID: "docs" } }])
    expect(host.commands()[0]).toMatchObject({ identity: "session.command:dynamic", provenance: { type: "mcp" } })
    expect(host.slashes()[0]?.identity).toBe("session.command:dynamic")
    expect(commandPaletteWinners(host.commands())[0]?.identity).toBe("session.command:dynamic")
    expect(await host("/dynamic")).toMatchObject({ identity: "session.command:dynamic" })
  })

  test("preserves server command provenance instead of granting Core trust", () => {
    expect(
      adaptServerCommands([
        { name: "prompt", source: "command", provenance: { type: "custom" } },
        { name: "docs", source: "mcp", provenance: { type: "mcp", serverID: "docs-server" } },
        { name: "review", source: "skill", provenance: { type: "skill", location: "/skills/review/SKILL.md" } },
      ]).map((command) => command.provenance),
    ).toEqual([
      { type: "custom-command" },
      { type: "mcp", serverID: "docs-server" },
      { type: "skill", location: "/skills/review/SKILL.md" },
    ])
  })

  test("keeps hidden Skill compatibility on the upstream session resolver", async () => {
    const host = createCommandHost({
      register: () => undefined,
      context: (source) => ({ ...context, source }),
      upstream: () =>
        adaptServerCommands([
          {
            name: "review-skill",
            source: "skill",
            provenance: { type: "skill", location: "Imported" },
          },
        ]),
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.slashes()).toEqual([])
    expect(commandPaletteWinners(host.commands()).filter((command) => !command.hidden)).toEqual([])
    expect(await host("/review-skill keep $ARGUMENTS and $1")).toMatchObject({
      status: "session",
      identity: "session.command:review-skill",
      command: "review-skill",
      arguments: "keep $ARGUMENTS and $1",
      provenance: { type: "skill", location: "Imported" },
    })
  })
})
