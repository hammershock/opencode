import { describe, expect, test } from "bun:test"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRoot } from "@opencode-ai/core/sync/root"

describe("SyncRoot", () => {
  test("uses the runtime Web Crypto receiver when no deterministic ID source is injected", async () => {
    const remote = memory()
    const root = SyncRoot.make({ provider: remote.adapter, sleep: async () => {} })

    const manifest = await root.initialize()
    const cleared = await root.clear()

    expect(manifest.instanceID).toMatch(/^[0-9a-f-]{36}$/)
    expect(cleared.reset.resetID).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("publishes a verified v2 control pointer and derives isolated account paths", async () => {
    const remote = memory()
    const root = SyncRoot.make({
      provider: remote.adapter,
      now: () => 10,
      randomUUID: () => "instance-a",
      sleep: async () => {},
    })

    const manifest = await root.initialize()

    expect(manifest).toEqual({
      version: 2,
      state: "ready",
      protocol: { major: 1, minor: 0 },
      instanceID: "instance-a",
      createdAt: 10,
    })
    expect(await remote.adapter.stat(SyncRoot.CONTROL_PATH)).toBeDefined()
    expect(await remote.adapter.stat("instances/instance-a/instance.json")).toBeDefined()
    expect(SyncRoot.accountScope("instance-a")).toBe("account-v2:instance-a")
    expect(SyncRoot.accountInstanceID("account-v2:instance-a")).toBe("instance-a")
    expect(SyncRoot.instanceRoot("instance-a")).toBe(`${SyncRoot.REMOTE_ROOT}/instances/instance-a`)
  })

  test("reports a legacy v1 root instead of silently initializing over it", async () => {
    const remote = memory()
    await remote.adapter.uploadAtomic(
      SyncRoot.LEGACY_MANIFEST_PATH,
      bytes(JSON.stringify({ version: 1, protocol: { major: 1, minor: 0 }, createdAt: 5 })),
      { type: "absent" },
    )
    const root = SyncRoot.make({ provider: remote.adapter, randomUUID: () => "instance-a" })

    expect(await root.inspect()).toEqual({
      status: "legacy-upgrade-required",
      manifest: { version: 1, protocol: { major: 1, minor: 0 }, createdAt: 5 },
    })
    await expect(root.initialize()).rejects.toMatchObject({ kind: "invalid" })
    expect(await remote.adapter.stat(SyncRoot.CONTROL_PATH)).toBeUndefined()
  })

  test("keeps writes from a stale instance invisible after reset and reinitialization", async () => {
    const remote = memory()
    const ids = ["instance-old", "reset-a", "instance-new"]
    const root = SyncRoot.make({ provider: remote.adapter, now: () => 10, randomUUID: () => ids.shift()! })
    await root.initialize()
    await remote.adapter.uploadAtomic("instances/instance-old/devices/mac.head.json", bytes("old"), { type: "absent" })

    expect(await root.clear()).toMatchObject({ invalidated: true, cleanup: "complete" })
    await remote.adapter.uploadAtomic("instances/instance-old/segments/mac/2-2.json", bytes("late"), {
      type: "absent",
    })
    const current = await root.initialize()

    expect(current.instanceID).toBe("instance-new")
    expect(await root.inspect()).toEqual({ status: "ready", manifest: current })
    expect(await remote.adapter.stat("instances/instance-old/segments/mac/2-2.json")).toBeDefined()
    expect(await remote.adapter.stat("instances/instance-new/segments/mac/2-2.json")).toBeUndefined()
  })

  test("rejects initialization when another writer wins the current pointer", async () => {
    const remote = memory()
    const winner: SyncRoot.Manifest = {
      version: 2,
      state: "ready",
      protocol: { major: 1, minor: 0 },
      instanceID: "instance-b",
      createdAt: 11,
    }
    remote.afterUpload = async (path) => {
      if (path !== SyncRoot.CONTROL_PATH) return
      remote.afterUpload = undefined
      await remote.adapter.uploadAtomic(path, bytes(JSON.stringify(winner)), { type: "any" })
    }
    const root = SyncRoot.make({ provider: remote.adapter, now: () => 10, randomUUID: () => "instance-a" })

    await expect(root.initialize()).rejects.toMatchObject({ kind: "conflict" })
    expect(await root.inspect()).toEqual({ status: "ready", manifest: winner })
  })

  test("commits reset before cleanup and reports incomplete physical cleanup without reviving the root", async () => {
    const remote = memory()
    const ids = ["instance-a", "reset-a"]
    const root = SyncRoot.make({ provider: remote.adapter, now: () => 10, randomUUID: () => ids.shift()! })
    await root.initialize()
    await remote.adapter.uploadAtomic("instances/instance-a/devices/mac.head.json", bytes("head"), { type: "absent" })
    remote.conflictDeletePrefix = "instances/instance-a"

    const result = await root.clear()

    expect(result).toMatchObject({ invalidated: true, cleanup: "pending" })
    expect(await root.inspect()).toEqual({
      status: "uninitialized",
      reset: { version: 2, state: "reset", resetID: "reset-a", resetAt: 10 },
    })
  })

  test("does not replace an existing epoch after transient exact-path misses", async () => {
    const remote = memory()
    const original = SyncRoot.make({
      provider: remote.adapter,
      now: () => 10,
      randomUUID: () => "instance-old",
      sleep: async () => {},
    })
    const manifest = await original.initialize()
    let misses = 2
    const guarded = SyncRoot.make({
      provider: {
        ...remote.adapter,
        stat: (path, signal) => {
          if (path === SyncRoot.CONTROL_PATH && misses-- > 0) return Promise.resolve(undefined)
          return remote.adapter.stat(path, signal)
        },
      },
      now: () => 20,
      randomUUID: () => "instance-new",
      sleep: async () => {},
    })

    expect(await guarded.initialize()).toEqual(manifest)
    expect(await remote.adapter.stat("instances/instance-new/instance.json")).toBeUndefined()
  })
})

function memory() {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const result: {
    values: typeof values
    afterUpload?: (path: string) => Promise<void>
    conflictDeletePrefix?: string
    adapter: SyncProvider.Adapter
  } = {
    values,
    adapter: {
      id: "memory",
      async list(prefix) {
        return {
          objects: [...values]
            .filter(([path]) => path === prefix || path.startsWith(`${prefix}/`))
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
        await result.afterUpload?.(path)
        return { path, version, size: value.length }
      },
      async deleteBatch(objects) {
        return objects.map((object) => {
          const value = values.get(object.path)
          if (!value) return { path: object.path, status: "missing" as const }
          if (result.conflictDeletePrefix && object.path.startsWith(result.conflictDeletePrefix))
            return { path: object.path, status: "conflict" as const, version: value.version }
          if (object.version && value.version !== object.version)
            return { path: object.path, status: "conflict" as const, version: value.version }
          values.delete(object.path)
          return { path: object.path, status: "deleted" as const }
        })
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
