import { describe, expect, test } from "bun:test"
import type { RexdLease } from "../../src/rexd/connection"
import { makeWizardConnectionProbe } from "../../src/rexd/target-registry"

const target = {
  name: "Remote",
  transport: "ssh" as const,
  connection: { type: "ssh-config" as const, host: "remote" },
  workspaceRoots: ["/workspace"],
  defaultDirectory: "/workspace",
}

describe("target wizard Rexd connection", () => {
  test("shares one managed lease across inspect and repeated completion", async () => {
    let connects = 0
    let closes = 0
    let lists = 0
    const wizard = makeWizardConnectionProbe({
      connect: async (input) => {
        connects++
        expect(input.workspaceRoots).toEqual(["/"])
        return lease(
          async () => {
            lists++
            return {
              entries: [
                { name: "project", path: "/home/hammer/project", type: "dir" },
                { name: "notes.txt", path: "/home/hammer/notes.txt", type: "file" },
              ],
            }
          },
          () => closes++,
        )
      },
    })

    expect(await wizard.inspect(target)).toEqual({ home: "/home/hammer" })
    expect((await wizard.complete(target, { value: "~/p", cursor: 3, cwd: "/" })).candidates).toEqual([
      "/home/hammer/project/",
    ])
    await wizard.complete(target, { value: "/home/hammer/", cursor: 13, cwd: "/" })

    expect(connects).toBe(1)
    expect(lists).toBe(2)
    expect(closes).toBe(0)
    await wizard.close()
    expect(closes).toBe(1)
  })

  test("evicts a failed lease so the next completion reconnects", async () => {
    let connects = 0
    let closes = 0
    const wizard = makeWizardConnectionProbe({
      connect: async () => {
        const current = ++connects
        return lease(
          async () => {
            if (current === 1) throw new Error("transport closed")
            return { entries: [] }
          },
          () => closes++,
        )
      },
    })

    await expect(wizard.complete(target, { value: "/", cursor: 1, cwd: "/" })).rejects.toThrow("transport closed")
    expect(await wizard.complete(target, { value: "/", cursor: 1, cwd: "/" })).toMatchObject({ candidates: [] })
    expect(connects).toBe(2)
    await wizard.close()
    expect(closes).toBe(2)
  })

  test("expires an idle lease", async () => {
    let connects = 0
    let closes = 0
    const wizard = makeWizardConnectionProbe({
      idleMs: 5,
      connect: async () => {
        connects++
        return lease(
          async () => ({ entries: [] }),
          () => closes++,
        )
      },
    })

    await wizard.inspect(target)
    await Bun.sleep(20)
    expect(closes).toBe(1)
    await wizard.inspect(target)
    expect(connects).toBe(2)
    await wizard.close()
  })
})

function lease(request: (method: string) => Promise<unknown>, close: () => void): RexdLease {
  return {
    client: { request } as unknown as RexdLease["client"],
    handshake: {
      sessionID: "wizard",
      protocol: "rexd/1",
      serverVersion: "0.1.5",
      capabilities: ["exec", "fs", "events", "pty"],
      limits: { default_timeout_ms: 30_000, max_output_bytes: 1_048_576 },
      workspaceRoots: ["/"],
    },
    prepared: {
      platform: "linux-amd64",
      home: "/home/hammer",
      dataHome: "/home/hammer/.local/share",
      configHome: "/home/hammer/.config",
      wsl: false,
      installed: false,
      binary: "/rexd",
      config: "/config.toml",
    },
    close: async () => void close(),
  }
}
