import { describe, expect, test } from "bun:test"
import { RexdError } from "../../src/rexd/error"
import { RexdRpcClient, validateHandshake } from "../../src/rexd/rpc"
import type { Transport } from "../../src/rexd/ssh"

describe("Rexd handshake", () => {
  test("requires protocol, version, capabilities, limits and roots", () => {
    expect(validateHandshake(handshake())).toEqual(
      expect.objectContaining({ protocol: "rexd/1", sessionID: "session-1", serverVersion: "0.1.5" }),
    )
    for (const capability of ["exec", "fs", "events", "pty"]) {
      expect(() =>
        validateHandshake(
          handshake({ capabilities: ["exec", "fs", "events", "pty"].filter((item) => item !== capability) }),
        ),
      ).toThrow(RexdError)
    }
    expect(() => validateHandshake(handshake({ protocol: "rexd/2" }))).toThrow("not compatible")
    expect(() => validateHandshake(handshake({ server_version: "0.1.4" }))).toThrow("incompatible")
    expect(() => validateHandshake(handshake({ limits: {} }))).toThrow("required limits")
    expect(() => validateHandshake(handshake({ workspace_roots: [] }))).toThrow("workspace roots")
  })

  test("multiplexes responses and sends the complete open contract", async () => {
    const transport = new FakeTransport()
    const client = new RexdRpcClient(transport)
    const opened = client.open({ clientVersion: "1.2.3", workspaceRoots: ["/work"] })
    const request = JSON.parse(transport.writes[0]!)
    expect(request).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "session.open",
      params: {
        client_name: "opencode-transit",
        client_version: "1.2.3",
        workspace_roots: ["/work"],
        requested_capabilities: ["exec", "fs", "events", "pty"],
      },
    })
    transport.data(JSON.stringify({ jsonrpc: "2.0", id: 1, result: handshake() }) + "\n")
    expect((await opened).sessionID).toBe("session-1")
    await client.close()
  })

  test("limits each NDJSON frame rather than the combined transport chunk", async () => {
    const transport = new FakeTransport()
    const client = new RexdRpcClient(transport, 100)
    const methods: string[] = []
    client.onNotification((method) => methods.push(method))
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "exec.stdout", params: {} }) + "\n"
    expect(Buffer.byteLength(frame.repeat(3))).toBeGreaterThan(100)
    transport.data(frame.repeat(3))
    expect(methods).toEqual(["exec.stdout", "exec.stdout", "exec.stdout"])
    expect(transport.closed).toBe(false)
    await client.close()
  })

  test("cancellation settles and removes a request without retry", async () => {
    const transport = new FakeTransport()
    const client = new RexdRpcClient(transport)
    const controller = new AbortController()
    const request = client.request("fs.stat", { path: "/work" }, { signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ phase: "cancelled", outcome: "failed" })
    expect(transport.writes).toHaveLength(1)
    await client.close()
  })

  test("marks an interrupted side effect unknown and never retries", async () => {
    const transport = new FakeTransport()
    const client = new RexdRpcClient(transport)
    const request = client.request("exec.start", { command: "touch file" }, { sideEffect: true })
    transport.fail(new RexdError("transport", "lost", true, "unknown"))
    await expect(request).rejects.toMatchObject({ phase: "transport", outcome: "unknown" })
    expect(transport.writes).toHaveLength(1)
  })

  test("marks cancellation after a side-effect request was sent as unknown", async () => {
    const transport = new FakeTransport()
    const client = new RexdRpcClient(transport)
    const controller = new AbortController()
    const request = client.request("fs.write", { path: "/work/file" }, { sideEffect: true, signal: controller.signal })
    controller.abort()
    await expect(request).rejects.toMatchObject({ phase: "cancelled", outcome: "unknown" })
    expect(transport.writes).toHaveLength(1)
    await client.close()
  })

  test("notifies runtime operations when the transport closes", async () => {
    const transport = new FakeTransport()
    const client = new RexdRpcClient(transport)
    const failures: RexdError[] = []
    client.onClose((error) => failures.push(error))
    const failure = new RexdError("transport", "lost", true, "unknown")
    transport.fail(failure)
    await Promise.resolve()
    expect(failures).toEqual([failure])
  })
})

class FakeTransport implements Transport {
  writes: string[] = []
  dataListeners = new Set<(chunk: string) => void>()
  closeListeners = new Set<(error: RexdError) => void>()
  closed = false

  async write(payload: string) {
    this.writes.push(payload)
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
  data(chunk: string) {
    this.dataListeners.forEach((listener) => listener(chunk))
  }
  fail(error: RexdError) {
    this.closeListeners.forEach((listener) => listener(error))
  }
}

function handshake(overrides: Record<string, unknown> = {}) {
  return {
    session_id: "session-1",
    protocol: "rexd/1",
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
    ...overrides,
  }
}
