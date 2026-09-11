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

  test("rejects truncated whole reads and supports bounded offset reads", async () => {
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
            content: Buffer.alloc(Number(params.length ?? 512 * 1024)).toString("base64"),
            truncated: true,
          }
        },
      },
    } as unknown as RexdLease

    await expect(new RexdFiles("gpu", lease).read("/large", "/")).rejects.toThrow("negotiated Rexd read limit")
    expect((await new RexdFiles("gpu", lease).readRange("/large", "/", 262_144, 262_144)).content).toHaveLength(262_144)
    expect(calls).toHaveLength(2)
    expect(calls[0]).not.toHaveProperty("offset")
    expect(calls[1]).toMatchObject({ offset: 262_144, length: 262_144, encoding: "base64" })
  })

  test("treats a bounded symlink chain ending in a directory as a directory", async () => {
    const paths: string[] = []
    const lease = {
      handshake: { sessionID: "session-1", workspaceRoots: ["/workspace"] },
      client: {
        async request(method: string, params: Readonly<Record<string, unknown>>) {
          expect(method).toBe("fs.stat")
          paths.push(String(params.path))
          if (params.path === "/workspace/link")
            return { path: params.path, exists: true, type: "symlink", symlink_target: "nested" }
          if (params.path === "/workspace/nested")
            return { path: params.path, exists: true, type: "symlink", symlink_target: "/workspace/project" }
          return { path: params.path, exists: true, type: "dir" }
        },
      },
    } as unknown as RexdLease

    expect(await new RexdFiles("gpu", lease).directoryStatus("link", "/workspace")).toEqual({
      status: "directory",
      path: "/workspace/link",
      resolvedPath: "/workspace/project",
    })
    expect(paths).toEqual(["/workspace/link", "/workspace/nested", "/workspace/project"])
  })

  test("rejects broken, looping, file, and outside-root symlink targets", async () => {
    const calls: string[] = []
    const lease = {
      handshake: { sessionID: "session-1", workspaceRoots: ["/workspace"] },
      client: {
        async request(_method: string, params: Readonly<Record<string, unknown>>) {
          const value = String(params.path)
          calls.push(value)
          if (value === "/workspace/broken")
            return { path: value, exists: true, type: "symlink", symlink_target: "missing" }
          if (value === "/workspace/missing") return { path: value, exists: false }
          if (value === "/workspace/loop-a")
            return { path: value, exists: true, type: "symlink", symlink_target: "loop-b" }
          if (value === "/workspace/loop-b")
            return { path: value, exists: true, type: "symlink", symlink_target: "loop-a" }
          if (value === "/workspace/file-link")
            return { path: value, exists: true, type: "symlink", symlink_target: "file" }
          if (value === "/workspace/file") return { path: value, exists: true, type: "file" }
          return { path: value, exists: true, type: "symlink", symlink_target: "/outside" }
        },
      },
    } as unknown as RexdLease
    const files = new RexdFiles("gpu", lease)

    expect(await files.directoryStatus("broken", "/workspace")).toMatchObject({
      status: "not-directory",
      reason: "broken-symlink",
    })
    expect(await files.directoryStatus("loop-a", "/workspace")).toMatchObject({
      status: "not-directory",
      reason: "symlink-loop",
    })
    expect(await files.directoryStatus("file-link", "/workspace")).toMatchObject({ status: "not-directory" })
    expect(await files.directoryStatus("outside-link", "/workspace")).toMatchObject({
      status: "not-directory",
      reason: "outside-roots",
    })
    expect(calls).not.toContain("/outside")
  })
})
