import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { spawn, withEnvironment } from "../../src/lsp/launch"
import { tmpdir } from "../fixture/fixture"
import { text } from "node:stream/consumers"

describe("lsp.launch", () => {
  test("injects the scoped location environment into a new server", async () => {
    const proc = await withEnvironment({ OPENCODE_LOCATION_TEST: "target-value" }, async () =>
      spawn(process.execPath, ["-e", "process.stdout.write(process.env.OPENCODE_LOCATION_TEST || '')"]),
    )
    expect(await text(proc.stdout)).toBe("target-value")
    expect(await proc.exited).toBe(0)
  })

  test("spawns cmd scripts with spaces on Windows", async () => {
    if (process.platform !== "win32") return

    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "with space")
    const file = path.join(dir, "echo cmd.cmd")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(file, "@echo off\r\nif %~1==--stdio exit /b 0\r\nexit /b 7\r\n")

    const proc = spawn(file, ["--stdio"])

    expect(await proc.exited).toBe(0)
  })
})
