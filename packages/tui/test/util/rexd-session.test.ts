import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  changeRexdSessionDirectory,
  executeRexdTargetCommand,
  parseDirectoryArgument,
  readRexdSession,
  writeRexdSessionDirectory,
} from "../../src/util/rexd-session"

const homes: string[] = []

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "opencode-rexd-session-"))
  homes.push(home)
  const sessionID = "session-1"
  const state = path.join(
    home,
    ".config/opencode/rexd-target/sessions",
    createHash("sha256").update(sessionID).digest("hex") + ".json",
  )
  mkdirSync(path.dirname(state), { recursive: true })
  mkdirSync(path.join(home, ".config/rexd"), { recursive: true })
  writeFileSync(
    state,
    JSON.stringify({ activeTargetAlias: "gpu", remoteCwdOverride: null, lastUsedAt: 1 }),
  )
  writeFileSync(
    path.join(home, ".config/rexd/targets.json"),
    JSON.stringify({
      targets: {
        gpu: {
          transport: "ssh",
          user: "hammer",
          home: "/workspace/home",
          defaultCwd: "/workspace/default",
          workspaceRoots: ["/workspace"],
        },
      },
    }),
  )
  return { home, sessionID, state }
}

afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

describe("REXD session context", () => {
  test("uses target defaults and persists a moved remote directory", () => {
    const item = fixture()
    expect(readRexdSession(item.home, item.sessionID)?.label).toBe("gpu:/workspace/default")

    expect(writeRexdSessionDirectory(item.home, item.sessionID, "/workspace/project/../demo")).toBe(true)
    expect(readRexdSession(item.home, item.sessionID)?.label).toBe("gpu:/workspace/demo")
    expect(JSON.parse(readFileSync(item.state, "utf8")).remoteCwdOverride).toBe("/workspace/demo")
  })

  test("rejects relative remote directories", () => {
    const item = fixture()
    expect(() => writeRexdSessionDirectory(item.home, item.sessionID, "workspace/demo")).toThrow("absolute path")
  })

  test("rejects directories outside the target workspace roots", () => {
    const item = fixture()
    expect(() => writeRexdSessionDirectory(item.home, item.sessionID, "/etc")).toThrow("inside: /workspace")
  })

  test("handles target commands without submitting a model prompt", () => {
    const item = fixture()
    expect(executeRexdTargetCommand(item.home, item.sessionID, "list").message).toContain("gpu")
    expect(executeRexdTargetCommand(item.home, item.sessionID, "clear").title).toContain("cleared")
    expect(readRexdSession(item.home, item.sessionID)).toBeUndefined()
    expect(executeRexdTargetCommand(item.home, item.sessionID, "use gpu").title).toContain("selected")
    expect(readRexdSession(item.home, item.sessionID)?.target).toBe("gpu")
  })

  test("resolves codex-style cd paths against the remote cwd and home", () => {
    const item = fixture()
    expect(changeRexdSessionDirectory(item.home, item.sessionID, "..")?.directory).toBe("/workspace")
    expect(changeRexdSessionDirectory(item.home, item.sessionID, "./demo")?.directory).toBe("/workspace/demo")
    expect(changeRexdSessionDirectory(item.home, item.sessionID, "~/repo")?.directory).toBe("/workspace/home/repo")
    expect(changeRexdSessionDirectory(item.home, item.sessionID, "'/workspace/a b'")?.directory).toBe("/workspace/a b")
    expect(parseDirectoryArgument("foo\\ bar")).toBe("foo bar")
  })
})
