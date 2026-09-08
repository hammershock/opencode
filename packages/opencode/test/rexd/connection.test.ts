import { describe, expect, test } from "bun:test"
import { testRexdConnection } from "../../src/rexd/connection"
import { RexdError } from "../../src/rexd/error"
import { powershellRemoteCommand, type RexdTarget, type Transport } from "../../src/rexd/ssh"

const target: RexdTarget = {
  id: "target-1",
  connection: { type: "ssh-config", host: "fixture" },
  workspaceRoots: ["/work"],
  command: { program: "/custom/rexd", args: ["--stdio"] },
}

describe("Rexd connection test", () => {
  test("quotes an explicit PowerShell bridge without a POSIX exec prefix", async () => {
    const transport = new ScriptedTransport({})
    let command = ""
    await testRexdConnection(
      {
        ...target,
        command: { program: "wsl.exe", args: ["-d", "Ubuntu", "-u", "user's name", "--", "rexd"] },
      },
      { clientVersion: "test" },
      {
        connect: (_target, value) => {
          command = value
          return transport
        },
        renderCommand: powershellRemoteCommand,
      },
    )
    expect(command).toBe("& 'wsl.exe' '-d' 'Ubuntu' '-u' 'user''s name' '--' 'rexd'")
  })

  test("validates the remote directory then gracefully closes the protocol and transport", async () => {
    const transport = new ScriptedTransport({ stat: { path: "/work/project", exists: true, type: "dir" } })
    const result = await testRexdConnection(
      target,
      { directory: "/work/project", clientVersion: "test" },
      { connect: () => transport },
    )
    expect(result.handshake.workspaceRoots).toEqual(["/work"])
    expect(transport.methods).toEqual(["session.open", "fs.stat", "session.close"])
    expect(transport.closed).toBe(true)
  })

  test("validates a directory reached through a relative symbolic link", async () => {
    const transport = new ScriptedTransport({
      stats: {
        "/work/link": { path: "/work/link", exists: true, type: "symlink", symlink_target: "project" },
        "/work/project": { path: "/work/project", exists: true, type: "dir" },
      },
    })
    await testRexdConnection(target, { directory: "/work/link", clientVersion: "test" }, { connect: () => transport })

    expect(transport.methods).toEqual(["session.open", "fs.stat", "fs.stat", "session.close"])
    expect(transport.closed).toBe(true)
  })

  test("rejects a symbolic link whose final target leaves the negotiated roots", async () => {
    const transport = new ScriptedTransport({
      stats: {
        "/work/link": { path: "/work/link", exists: true, type: "symlink", symlink_target: "/outside" },
      },
    })
    await expect(
      testRexdConnection(target, { directory: "/work/link", clientVersion: "test" }, { connect: () => transport }),
    ).rejects.toMatchObject({ phase: "directory" })

    expect(transport.methods).toEqual(["session.open", "fs.stat", "session.close"])
    expect(transport.closed).toBe(true)
  })

  test("rejects a directory outside negotiated roots without local fallback", async () => {
    const transport = new ScriptedTransport({ stat: { path: "/control-device/path", exists: true, type: "dir" } })
    await expect(
      testRexdConnection(
        target,
        { directory: "/control-device/path", clientVersion: "test" },
        { connect: () => transport },
      ),
    ).rejects.toMatchObject({ phase: "directory" })
    expect(transport.methods).toEqual(["session.open", "session.close"])
    expect(transport.closed).toBe(true)
  })

  test("cleans up transport after handshake failure", async () => {
    const transport = new ScriptedTransport({ protocol: "rexd/2" })
    await expect(
      testRexdConnection(target, { clientVersion: "test" }, { connect: () => transport }),
    ).rejects.toBeInstanceOf(RexdError)
    expect(transport.closed).toBe(true)
  })
})

class ScriptedTransport implements Transport {
  methods: string[] = []
  dataListeners = new Set<(chunk: string) => void>()
  closeListeners = new Set<(error: RexdError) => void>()
  closed = false

  constructor(readonly options: { protocol?: string; stat?: unknown; stats?: Readonly<Record<string, unknown>> }) {}

  async write(payload: string) {
    const request = JSON.parse(payload)
    this.methods.push(request.method)
    const result =
      request.method === "session.open"
        ? {
            session_id: "session-1",
            protocol: this.options.protocol ?? "rexd/1",
            server_version: "0.1.5",
            capabilities: ["exec", "fs", "events", "pty"],
            limits: {
              default_timeout_ms: 30_000,
              hard_timeout_ms: 300_000,
              max_output_bytes: 1_048_576,
              max_file_read_bytes: 1_048_576,
              max_processes_per_session: 8,
              max_concurrent_sessions: 16,
            },
            workspace_roots: ["/work"],
          }
        : request.method === "fs.stat"
          ? (this.options.stats?.[request.params.path] ?? this.options.stat)
          : { ok: true }
    queueMicrotask(() =>
      this.dataListeners.forEach((listener) =>
        listener(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`),
      ),
    )
  }
  onData(listener: (chunk: string) => void) {
    this.dataListeners.add(listener)
    return () => this.dataListeners.delete(listener)
  }
  onClose(listener: (error: RexdError) => void) {
    this.closeListeners.add(listener)
    return () => this.closeListeners.delete(listener)
  }
  async close() {
    this.closed = true
  }
}
