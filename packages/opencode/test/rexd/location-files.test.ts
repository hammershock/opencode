import { describe, expect, test } from "bun:test"
import type { RexdLease } from "../../src/rexd/connection"
import { RexdFiles } from "../../src/rexd/location-files"

describe("Rexd Location filesystem boundary", () => {
  test("routes reads and writes through scoped RPC without local fallback", async () => {
    const calls: Array<{ method: string; params: Readonly<Record<string, unknown>>; sideEffect?: boolean }> = []
    const lease = {
      handshake: { sessionID: "session-1", workspaceRoots: ["/workspace"] },
      client: {
        async request(method: string, params: Readonly<Record<string, unknown>>, options?: { sideEffect?: boolean }) {
          calls.push({ method, params, sideEffect: options?.sideEffect })
          if (method === "fs.stat") return { path: params.path, exists: true, type: "file", mtime: 1 }
          if (method === "fs.read")
            return {
              path: params.path,
              size: 5,
              mtime: 1,
              encoding: "base64",
              content: Buffer.from("hello").toString("base64"),
              truncated: false,
            }
          if (method === "fs.write") return { ok: true }
          throw new Error(`Unexpected method: ${method}`)
        },
      },
    } as unknown as RexdLease
    const files = new RexdFiles("gpu", lease)

    expect(Buffer.from((await files.read("note.txt", "/workspace")).content).toString()).toBe("hello")
    await files.write("note.txt", "/workspace", Buffer.from("next"))

    expect(calls.map((item) => item.method)).toEqual(["fs.read", "fs.write"])
    expect(calls[0]?.params.path).toBe("/workspace/note.txt")
    expect(calls[1]?.sideEffect).toBe(true)
  })

  test("rejects paths outside negotiated roots before issuing RPC", async () => {
    let called = false
    const lease = {
      handshake: { sessionID: "session-1", workspaceRoots: ["/workspace"] },
      client: {
        async request() {
          called = true
        },
      },
    } as unknown as RexdLease
    const files = new RexdFiles("gpu", lease)

    expect(() => files.resolve("../secret", "/workspace")).toThrow("outside negotiated roots")
    expect(called).toBe(false)
  })

  test("rejects truncated reads without using unsupported offset pagination", async () => {
    const calls: Readonly<Record<string, unknown>>[] = []
    const lease = {
      handshake: { sessionID: "session-1", workspaceRoots: ["/"] },
      client: {
        async request(_method: string, params: Readonly<Record<string, unknown>>) {
          calls.push(params)
          return {
            path: "/large",
            size: 600_000,
            mtime: 1,
            encoding: "base64",
            content: Buffer.alloc(512 * 1024).toString("base64"),
            truncated: true,
          }
        },
      },
    } as unknown as RexdLease

    await expect(new RexdFiles("gpu", lease).read("/large", "/")).rejects.toThrow("negotiated Rexd read limit")
    expect(calls).toHaveLength(1)
    expect(calls[0]).not.toHaveProperty("offset")
  })
})
