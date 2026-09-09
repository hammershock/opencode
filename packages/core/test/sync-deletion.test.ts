import { describe, expect, test } from "bun:test"
import { SyncDeletion } from "@opencode-ai/core/sync/deletion"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"

describe("SyncDeletion", () => {
  test("derives reference count from an idempotent device acknowledgement set", async () => {
    const remote = memory()
    const deletion = SyncDeletion.make({ provider: remote.adapter, now: () => 10 })
    const marker = await deletion.ensure({ id: "delete-1", sessionID: "session-1", deletedAt: 1 }, [
      SyncEvent.DeviceID.make("mac"),
      SyncEvent.DeviceID.make("windows"),
    ])
    expect((await deletion.references(marker, new Set())).map(String)).toEqual(["mac", "windows"])

    await deletion.acknowledge(marker, SyncEvent.DeviceID.make("mac"))
    await deletion.acknowledge(marker, SyncEvent.DeviceID.make("mac"))
    expect((await deletion.references(marker, new Set())).map(String)).toEqual(["windows"])
    expect(await deletion.references(marker, new Set([SyncEvent.DeviceID.make("windows")]))).toEqual([])

    await deletion.remove(marker)
    expect(await deletion.list()).toEqual([])
  })

  test("scans and removes multiple deletion records with one provider call per phase", async () => {
    const remote = memory()
    const deletion = SyncDeletion.make({ provider: remote.adapter, now: () => 10 })
    for (const sessionID of ["session-a", "session-b"]) {
      const marker = await deletion.ensure({ id: `delete-${sessionID}`, sessionID, deletedAt: 1 }, [
        SyncEvent.DeviceID.make("mac"),
      ])
      await deletion.acknowledge(marker, SyncEvent.DeviceID.make("mac"))
    }
    remote.counts.list = 0

    const snapshot = await deletion.scan()
    expect(snapshot).toHaveLength(2)
    expect(remote.counts.list).toBe(1)
    const downloads = remote.counts.download
    await deletion.scan()
    expect(remote.counts.download).toBe(downloads)
    await deletion.removeScanned(snapshot)
    expect(remote.counts.delete).toBe(1)
    expect(remote.values.size).toBe(0)
  })

  test("monotonically expands the frozen required-device set", async () => {
    const remote = memory()
    const deletion = SyncDeletion.make({ provider: remote.adapter, now: () => 10 })
    const tombstone = { id: "delete-union", sessionID: "session-union", deletedAt: 1 }
    await deletion.ensure(tombstone, [SyncEvent.DeviceID.make("mac")])
    const marker = await deletion.ensure(tombstone, [
      SyncEvent.DeviceID.make("mac"),
      SyncEvent.DeviceID.make("windows"),
    ])

    expect(marker.requiredDevices.map(String)).toEqual(["mac", "windows"])
    expect((await deletion.read("session-union"))?.requiredDevices.map(String)).toEqual(["mac", "windows"])
  })
})

function memory() {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  const counts = { list: 0, download: 0, delete: 0 }
  let revision = 0
  const conflict = (operation: "download" | "upload") =>
    new SyncProvider.ProviderError("memory", operation, "conflict", false)
  const adapter: SyncProvider.Adapter = {
    id: "memory",
    async list(prefix) {
      counts.list++
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
      counts.download++
      const value = values.get(path)
      if (!value || (version && version !== value.version)) throw conflict("download")
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
      counts.delete++
      return objects.map((object) => {
        values.delete(object.path)
        return { path: object.path, status: "deleted" as const }
      })
    },
  }
  return { adapter, values, counts }
}
