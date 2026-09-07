import { describe, expect, test } from "bun:test"
import {
  renderUpstreamCommandManifest,
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
})
