import { describe, expect, test } from "bun:test"
import { ConfigCommand } from "@/config/command"
import { tmpdir } from "../fixture/fixture"
import path from "node:path"
import fs from "node:fs/promises"

const sync = `---
description: Configure and manage cloud session sync
---

__OPENCODE_REXD_SYNC__ $ARGUMENTS
`

const devices = `---
description: Manage cloud sync devices and target names
---

__OPENCODE_REXD_DEVICES__
`

describe("legacy generated commands", () => {
  test("renames exact LF and CRLF signatures before discovery and is idempotent", async () => {
    await using tmp = await tmpdir()
    const commands = path.join(tmp.path, "commands")
    await fs.mkdir(commands)
    await Bun.write(path.join(commands, "sync.md"), sync)
    await Bun.write(path.join(commands, "devices.md"), devices.replaceAll("\n", "\r\n"))

    const first = await ConfigCommand.retireLegacy(tmp.path)
    expect(first.map((item) => path.basename(item.source))).toEqual(["devices.md", "sync.md"])
    expect(first.every((item) => item.backup && !item.error)).toBe(true)
    expect(await Bun.file(first.find((item) => item.source.endsWith("sync.md"))!.backup!).text()).toBe(sync)
    expect(await Bun.file(first.find((item) => item.source.endsWith("devices.md"))!.backup!).text()).toBe(
      devices.replaceAll("\n", "\r\n"),
    )
    expect(await ConfigCommand.load(tmp.path)).toEqual({})
    expect(await ConfigCommand.retireLegacy(tmp.path)).toEqual([])
  })

  test("preserves a same-name user command with any content change", async () => {
    await using tmp = await tmpdir()
    const commands = path.join(tmp.path, "commands")
    await fs.mkdir(commands)
    const custom = sync + "# user customization\n"
    await Bun.write(path.join(commands, "sync.md"), custom)

    expect(await ConfigCommand.retireLegacy(tmp.path)).toEqual([])
    expect(await Bun.file(path.join(commands, "sync.md")).text()).toBe(custom)
    expect((await ConfigCommand.load(tmp.path)).sync.template).toContain("user customization")
  })

  test("keeps a source file when retirement fails", async () => {
    await using tmp = await tmpdir()
    const commands = path.join(tmp.path, "commands")
    await fs.mkdir(commands)
    const source = path.join(commands, "sync.md")
    await Bun.write(source, sync)
    await fs.chmod(commands, 0o500)
    try {
      const result = await ConfigCommand.retireLegacy(tmp.path)
      expect(result).toHaveLength(1)
      expect(result[0].error).toBeDefined()
      expect(await Bun.file(source).text()).toBe(sync)
    } finally {
      await fs.chmod(commands, 0o700)
    }
  })
})
