import { describe, expect, test } from "bun:test"
import { SyncProvider } from "@opencode-ai/core/sync/provider"

describe("SyncProvider contract", () => {
  test("collects pagination and rejects provider cursor loops or prefix escapes", async () => {
    const store = memory(1)
    await store.uploadAtomic("space/a", bytes("a"), { type: "absent" })
    await store.uploadAtomic("space/b", bytes("b"), { type: "absent" })
    expect((await SyncProvider.listAll(store, "space")).map((item) => item.path)).toEqual(["space/a", "space/b"])

    const loop = { ...store, list: async () => ({ objects: [], cursor: "same" }) }
    await expect(SyncProvider.listAll(loop, "space")).rejects.toMatchObject({ kind: "invalid-response" })
    const escape = { ...store, list: async () => ({ objects: [{ path: "other/a", version: "1", size: 1 }] }) }
    await expect(SyncProvider.listAll(escape, "space")).rejects.toMatchObject({ kind: "invalid-response" })
  })

  test("provides atomic absent/version preconditions and versioned reads", async () => {
    const store = memory()
    const first = await store.uploadAtomic("space/head", bytes("one"), { type: "absent" })
    await expect(store.uploadAtomic("space/head", bytes("bad"), { type: "absent" })).rejects.toMatchObject({
      kind: "conflict",
    })
    const second = await store.uploadAtomic("space/head", bytes("two"), { type: "version", version: first.version })
    expect(text((await store.download("space/head", second.version)).bytes)).toBe("two")
    await expect(store.download("space/head", first.version)).rejects.toMatchObject({ kind: "conflict" })
  })

  test("reports per-object delete conflicts without treating missing as failure", async () => {
    const store = memory()
    const item = await store.uploadAtomic("space/a", bytes("a"), { type: "absent" })
    expect(
      await store.deleteBatch([
        { path: "space/a", version: "wrong" },
        { path: "space/missing" },
        { path: "space/a", version: item.version },
      ]),
    ).toEqual([
      { path: "space/a", status: "conflict", version: item.version },
      { path: "space/missing", status: "missing" },
      { path: "space/a", status: "deleted" },
    ])
  })

  test("resolves an unknown upload outcome by stat, pinned download and verification", async () => {
    const store = memory()
    const uploaded = await store.uploadAtomic("space/object", bytes("ciphertext"), { type: "absent" })
    expect(
      await SyncProvider.resolveUnknownUpload({
        adapter: store,
        path: "space/object",
        expectedVersion: uploaded.version,
        verify: async (object) => text(object.bytes) === "ciphertext",
      }),
    ).toMatchObject({ status: "committed" })
    expect(
      await SyncProvider.resolveUnknownUpload({
        adapter: store,
        path: "space/object",
        verify: async () => false,
      }),
    ).toMatchObject({ status: "conflict" })
  })

  test("rejects paths that could escape or alias the encrypted namespace", () => {
    for (const value of ["", "/root", "space/../other", "space//a", "space\\a", "space/./a", "space/a/"])
      expect(() => SyncProvider.objectPath(value)).toThrow()
  })
})

function memory(pageSize = 100): SyncProvider.Adapter {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const conflict = (operation: "download" | "upload") =>
    new SyncProvider.ProviderError("memory", operation, "conflict", false)
  return {
    id: "memory",
    async list(prefix, cursor) {
      const offset = cursor ? Number(cursor) : 0
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .sort(([a], [b]) => a.localeCompare(b))
      return {
        objects: entries.slice(offset, offset + pageSize).map(([path, item]) => ({
          path,
          version: item.version,
          size: item.bytes.length,
        })),
        cursor: offset + pageSize < entries.length ? String(offset + pageSize) : undefined,
      }
    },
    async stat(path) {
      const item = values.get(path)
      return item ? { path, version: item.version, size: item.bytes.length } : undefined
    },
    async download(path, version) {
      const item = values.get(path)
      if (!item) throw new SyncProvider.ProviderError("memory", "download", "not-found", false)
      if (version && version !== item.version) throw conflict("download")
      return { path, version: item.version, size: item.bytes.length, bytes: item.bytes.slice() }
    },
    async uploadAtomic(path, value, precondition) {
      const found = values.get(path)
      if (precondition.type === "absent" && found) throw conflict("upload")
      if (precondition.type === "version" && found?.version !== precondition.version) throw conflict("upload")
      const version = String(++revision)
      values.set(path, { version, bytes: value.slice() })
      return { path, version, size: value.length }
    },
    async deleteBatch(objects) {
      return objects.map((object) => {
        const found = values.get(object.path)
        if (!found) return { path: object.path, status: "missing" as const }
        if (object.version && object.version !== found.version)
          return { path: object.path, status: "conflict" as const, version: found.version }
        values.delete(object.path)
        return { path: object.path, status: "deleted" as const }
      })
    },
  }
}

function bytes(value: string) {
  return new TextEncoder().encode(value)
}

function text(value: Uint8Array) {
  return new TextDecoder().decode(value)
}
