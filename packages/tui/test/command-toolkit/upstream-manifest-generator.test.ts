import { describe, expect, test } from "bun:test"
import {
  renderUpstreamCommandManifest,
  validateSlashCommandDescriptions,
  validateUpstreamCommandCatalog,
} from "../../script/generate-upstream-command-manifest"

const command = {
  sourceRef: "337fd144d2ba",
  contractVersion: 1,
  contract: {
    identity: "app.exit",
    host: "tui.app",
    path: ["exit"],
    aliases: [["q"]],
    title: "Exit the app",
    category: "System",
    availability: "all-routes",
    inputBoundary: "no-arguments",
  },
}

describe("upstream command manifest generator", () => {
  test("requires every executable override target", () => {
    expect(() => validateUpstreamCommandCatalog({ version: 1, commands: { appExit: command } })).toThrow(
      "Missing required upstream command sessionRename",
    )
  })

  test("derives the fingerprint from the source fixture", async () => {
    const generated = await renderUpstreamCommandManifest({
      version: 1,
      commands: {
        appExit: command,
        sessionRename: { ...command, contract: { ...command.contract, identity: "session.rename" } },
      },
    })
    expect(generated).toContain('"337fd144d2ba:app.exit:v1"')
    expect(generated).toContain('"337fd144d2ba:session.rename:v1"')
  })

  test("rejects a slash command without reviewed purpose text", () => {
    expect(() =>
      validateSlashCommandDescriptions([
        {
          name: "fixture.ts",
          source: `const commands = [
  {
    name: "session.list",
    slashName: "sessions",
  },
]`,
        },
      ]),
    ).toThrow("Slash commands require reviewed descriptions: fixture.ts:2")

    expect(() =>
      validateSlashCommandDescriptions([
        {
          name: "fixture.tsx",
          source: `const commands = [
  {
    value: "session.list",
    description: "Search sessions",
    slash: {
      name: "sessions",
    },
  },
]`,
        },
      ]),
    ).not.toThrow()

    expect(() =>
      validateSlashCommandDescriptions([
        {
          name: "empty.ts",
          source: `const commands = [
  {
    name: "session.list",
    desc: "",
    slashName: "sessions",
  },
]`,
        },
      ]),
    ).toThrow("Slash commands require reviewed descriptions: empty.ts:2")

    expect(() =>
      validateSlashCommandDescriptions([
        { name: "inline.ts", source: `const command = { ["slashName"]: "sessions" }` },
        { name: "builtin.ts", source: `const command = { name: "init", provenance: { type: "builtin" } }` },
      ]),
    ).toThrow("inline.ts:1, builtin.ts:1")
  })
})
