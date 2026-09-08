import { describe, expect, test } from "bun:test"
import type { RexdLease } from "../../src/rexd/connection"
import { make } from "../../src/rexd/connection-pool"
import { RexdError } from "../../src/rexd/error"
import type { RexdTarget } from "../../src/rexd/ssh"

const target: RexdTarget = {
  id: "target-1",
  connection: { type: "ssh-config", host: "remote" },
  workspaceRoots: ["/work"],
}

describe("Rexd connection pool", () => {
  test("deduplicates concurrent and sequential consumers", async () => {
    let connects = 0
    let closes = 0
    const pool = make({
      idleMs: 20,
      validate: async () => undefined,
      connect: async () => {
        connects++
        await Bun.sleep(5)
        return lease(() => closes++)
      },
    })

    const [first, second] = await Promise.all([
      pool.acquire(target, { directory: "/work/one", clientVersion: "test" }),
      pool.acquire(target, { directory: "/work/two", clientVersion: "test" }),
    ])
    expect(first.lease).toBe(second.lease)
    expect(connects).toBe(1)
    await first.release()
    await second.release()
    const third = await pool.acquire(target, { clientVersion: "test" })
    expect(third.lease).toBe(first.lease)
    await third.release()
    await Bun.sleep(30)
    expect(closes).toBe(1)

    const fourth = await pool.acquire(target, { clientVersion: "test" })
    expect(connects).toBe(2)
    await fourth.release()
    await pool.close()
    expect(closes).toBe(2)
  })

  test("does not reuse a transport after configuration changes or closure", async () => {
    let connects = 0
    const closeListeners: Array<(error: RexdError) => void> = []
    const pool = make({
      validate: async () => undefined,
      connect: async () => lease(undefined, (listener) => closeListeners.push(listener), String(++connects)),
    })

    const first = await pool.acquire(target, { clientVersion: "test" })
    const changed = await pool.acquire({ ...target, workspaceRoots: ["/"] }, { clientVersion: "test" })
    expect(first.lease).not.toBe(changed.lease)
    expect(connects).toBe(2)

    closeListeners[0]!(new RexdError("transport", "closed", true))
    const replacement = await pool.acquire(target, { clientVersion: "test" })
    expect(replacement.lease).not.toBe(first.lease)
    expect(connects).toBe(3)
    await Promise.all([first.release(), changed.release(), replacement.release()])
    await pool.close()
  })

  test("keeps a valid connection warm after directory validation fails", async () => {
    let connects = 0
    const pool = make({
      connect: async () => {
        connects++
        return lease()
      },
      validate: async (_targetID, _lease, directory) => {
        if (directory === "/missing") throw new RexdError("directory", "missing", false)
      },
    })

    await expect(pool.acquire(target, { directory: "/missing", clientVersion: "test" })).rejects.toMatchObject({
      phase: "directory",
    })
    const handle = await pool.acquire(target, { directory: "/work", clientVersion: "test" })
    expect(connects).toBe(1)
    await handle.release()
    await pool.close()
  })
})

function lease(
  close: (() => void) | undefined = undefined,
  onClose: (listener: (error: RexdError) => void) => void = () => undefined,
  sessionID = "session",
): RexdLease {
  return {
    client: {
      onClose: (listener: (error: RexdError) => void) => (onClose(listener), () => undefined),
    } as unknown as RexdLease["client"],
    handshake: {
      sessionID,
      protocol: "rexd/1",
      serverVersion: "0.1.5",
      capabilities: ["exec", "fs", "events", "pty"],
      limits: { default_timeout_ms: 30_000, max_output_bytes: 1_048_576 },
      workspaceRoots: ["/work"],
    },
    close: async () => close?.(),
  }
}
