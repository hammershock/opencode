import { describe, expect, test } from "bun:test"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRoot } from "@opencode-ai/core/sync/root"

describe("SyncRoot", () => {
  test("uses the manifest as the only initialization commit", async () => {
    const remote = memory()
    const root = SyncRoot.make({ provider: remote.adapter, now: () => 10 })
    await remote.adapter.uploadAtomic("segments/orphan/1.json", bytes("orphan"), { type: "absent" })
    expect(await root.inspect()).toEqual({ status: "uninitialized" })

    expect(await root.initialize()).toEqual({ version: 1, protocol: { major: 1, minor: 0 }, createdAt: 10 })
    expect(await remote.adapter.stat("segments/orphan/1.json")).toBeUndefined()
    expect((await root.inspect()).status).toBe("ready")
  })

  test("invalidates the manifest before destructive cleanup", async () => {
    const remote = memory()
    const root = SyncRoot.make({ provider: remote.adapter, now: () => 10 })
    await root.initialize()
    await remote.adapter.uploadAtomic("devices/mac.head.json", bytes("head"), { type: "absent" })
    remote.beforeDelete = async (paths) => {
      if (!paths.includes("manifest.json")) return
      expect(await root.inspect()).toEqual({ status: "uninitialized" })
    }
    await root.clear()
    expect([...remote.values.keys()]).toEqual([])
  })
})

function memory() {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const result: {
    values: typeof values
    beforeDelete?: (paths: string[]) => Promise<void>
    adapter: SyncProvider.Adapter
  } = {
    values,
    adapter: {
      id: "memory",
      async list(prefix) {
        return {
          objects: [...values]
            .filter(([path]) => path.startsWith(prefix))
            .map(([path, value]) => ({ path, version: value.version, size: value.bytes.length })),
        }
      },
      async stat(path) {
        const value = values.get(path)
        return value ? { path, version: value.version, size: value.bytes.length } : undefined
      },
      async download(path, version) {
        const value = values.get(path)
        if (!value || (version && version !== value.version)) throw conflict("download")
        return { path, version: value.version, size: value.bytes.length, bytes: value.bytes.slice() }
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
        for (const object of objects) values.delete(object.path)
        await result.beforeDelete?.(objects.map((item) => item.path))
        return objects.map((item) => ({ path: item.path, status: "deleted" as const }))
      },
    },
  }
  return result
}

function conflict(operation: "download" | "upload") {
  return new SyncProvider.ProviderError("memory", operation, "conflict", false)
}

function bytes(value: string) {
  return new TextEncoder().encode(value)
}
