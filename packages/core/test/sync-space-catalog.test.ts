import { describe, expect, test } from "bun:test"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncSpace } from "@opencode-ai/core/sync/space"
import { SyncSpaceCatalog } from "@opencode-ai/core/sync/space-catalog"

describe("SyncSpaceCatalog contract", () => {
  test("creates discoverable isolated descriptors with plaintext default and optional recovery key", async () => {
    const provider = memory()
    const plain = SyncSpaceCatalog.make({
      provider,
      now: () => 10,
      createSpace: () => key("plain"),
    })
    const createdPlain = await plain.create({ name: "Plain" })
    expect(createdPlain.descriptor.encryption).toBe("none")
    expect(createdPlain.recoveryString).toBeUndefined()

    const encrypted = SyncSpaceCatalog.make({
      provider,
      now: () => 20,
      createSpace: () => key("encrypted"),
    })
    const createdEncrypted = await encrypted.create({ name: "Encrypted", encryption: "aes-256-gcm" })
    expect(await SyncCrypto.importRecoveryString(createdEncrypted.recoveryString!)).toMatchObject({
      namespaceID: "encrypted",
    })
    expect((await plain.discover()).spaces.map((item) => [item.status, item.descriptor.name])).toEqual([
      ["compatible", "Encrypted"],
      ["compatible", "Plain"],
    ])
    expect((await plain.join("plain")).protocol.encryption).toBe("none")
  })

  test("makes descriptor and protocol creation idempotent but rejects an encoding change", async () => {
    const provider = memory()
    const catalog = SyncSpaceCatalog.make({ provider, now: () => 10, createSpace: () => key("stable") })
    expect((await catalog.create({ name: "Stable" })).descriptor.namespaceID).toBe("stable")
    expect((await catalog.create({ name: "Stable" })).descriptor.namespaceID).toBe("stable")
    await expect(catalog.create({ name: "Stable", encryption: "aes-256-gcm" })).rejects.toMatchObject({
      kind: "conflict",
    })
    expect((await catalog.join("stable")).protocol.encryption).toBe("none")
  })

  test("keeps unsupported protocols summary-only and blocks join or replacement writes", async () => {
    const provider = memory()
    const descriptor = space("future", { major: 2, minor: 0 })
    await provider.uploadAtomic("catalog/future.json", encode(descriptor), { type: "absent" })
    const catalog = SyncSpaceCatalog.make({ provider, now: () => 10, createSpace: () => key("future") })
    expect(await catalog.discover()).toEqual({
      spaces: [{ status: "unsupported", descriptor }],
      deletions: [],
    })
    await expect(catalog.join("future")).rejects.toMatchObject({ kind: "unsupported" })
    await expect(catalog.create({ name: "Future" })).rejects.toMatchObject({ kind: "conflict" })
    expect(provider.downloads.some((path) => path.startsWith("spaces/future/"))).toBe(false)
  })

  test("publishes a permanent deletion marker before cleanup and completes cleanup on retry", async () => {
    const base = memory()
    const catalog = SyncSpaceCatalog.make({ provider: base, now: () => 10, createSpace: () => key("gone") })
    await catalog.create({ name: "Gone" })
    await base.uploadAtomic("spaces/gone/devices/a.head", encode({ head: true }), { type: "absent" })
    const crashing: SyncProvider.Adapter = {
      ...base,
      async deleteBatch() {
        expect(await base.stat("deleted-spaces/gone.json")).toBeDefined()
        throw new Error("crash after marker")
      },
    }
    await expect(SyncSpaceCatalog.make({ provider: crashing, now: () => 30 }).remove("gone")).resolves.toMatchObject({
      cleanup: "pending",
    })
    expect(await base.stat("deleted-spaces/gone.json")).toBeDefined()
    expect(await base.stat("catalog/gone.json")).toBeDefined()

    await catalog.remove("gone")
    expect(await base.stat("catalog/gone.json")).toBeUndefined()
    expect(await base.stat("spaces/gone/protocol.json")).toBeUndefined()
    expect(await base.stat("spaces/gone/devices/a.head")).toBeUndefined()
    expect(await base.stat("deleted-spaces/gone.json")).toBeDefined()
  })

  test("deletion dominates stale catalog resurrection and a deleted ID is never reusable", async () => {
    const provider = memory()
    const catalog = SyncSpaceCatalog.make({ provider, now: () => 10, createSpace: () => key("deleted") })
    const stale = (await catalog.create({ name: "Deleted" })).descriptor
    await catalog.remove("deleted")
    await provider.uploadAtomic("catalog/deleted.json", encode({ ...stale, revision: 99 }), { type: "absent" })
    expect((await catalog.discover()).spaces).toEqual([])
    expect((await catalog.discover()).deletions).toHaveLength(1)
    await expect(catalog.inspect("deleted")).rejects.toMatchObject({ kind: "deleted" })
    await expect(catalog.create({ name: "Deleted again" })).rejects.toMatchObject({ kind: "deleted" })
  })
})

function key(namespaceID: string): SyncCrypto.SpaceKey {
  return { namespaceID, rootKey: new Uint8Array(32).fill(7) }
}

function space(namespaceID: string, protocol: SyncSpace.Protocol): SyncSpace.Descriptor {
  return {
    namespaceID,
    name: "Future",
    protocol,
    encryption: "none",
    createdAt: 1,
    updatedAt: 1,
    summary: { sessions: 4, devices: 2, updatedAt: 1 },
    revision: 1,
  }
}

function memory(): SyncProvider.Adapter & { readonly downloads: string[] } {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  const downloads: string[] = []
  let revision = 0
  const conflict = (operation: "download" | "upload") =>
    new SyncProvider.ProviderError("memory", operation, "conflict", false)
  return {
    id: "memory",
    downloads,
    async list(prefix) {
      return {
        objects: [...values.entries()]
          .filter(([path]) => path === prefix || path.startsWith(`${prefix}/`))
          .toSorted(([left], [right]) => left.localeCompare(right))
          .map(([path, value]) => ({ path, version: value.version, size: value.bytes.length })),
      }
    },
    async stat(path) {
      const value = values.get(path)
      return value ? { path, version: value.version, size: value.bytes.length } : undefined
    },
    async download(path, version) {
      downloads.push(path)
      const value = values.get(path)
      if (!value) throw new SyncProvider.ProviderError("memory", "download", "not-found", false)
      if (version && version !== value.version) throw conflict("download")
      return { path, version: value.version, size: value.bytes.length, bytes: value.bytes.slice() }
    },
    async uploadAtomic(path, bytes, precondition) {
      const value = values.get(path)
      if (precondition.type === "absent" && value) throw conflict("upload")
      if (precondition.type === "version" && value?.version !== precondition.version) throw conflict("upload")
      const version = String(++revision)
      values.set(path, { version, bytes: bytes.slice() })
      return { path, version, size: bytes.length }
    },
    async deleteBatch(objects) {
      return objects.map((object) => {
        const value = values.get(object.path)
        if (!value) return { path: object.path, status: "missing" as const }
        if (object.version && object.version !== value.version)
          return { path: object.path, status: "conflict" as const, version: value.version }
        values.delete(object.path)
        return { path: object.path, status: "deleted" as const }
      })
    },
  }
}

function encode(value: unknown) {
  return new TextEncoder().encode(JSON.stringify(value))
}
