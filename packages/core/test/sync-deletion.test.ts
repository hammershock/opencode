import { describe, expect, test } from "bun:test"
import { SyncDeletion } from "@opencode-ai/core/sync/deletion"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"

describe("SyncDeletion", () => {
  test("derives reference count from an idempotent device acknowledgement set", async () => {
    const remote = memory()
    const deletion = SyncDeletion.make({ provider: remote.adapter, now: () => 10 })
    const marker = await deletion.ensure(
      { id: "delete-1", sessionID: "session-1", deletedAt: 1 },
      [SyncEvent.DeviceID.make("mac"), SyncEvent.DeviceID.make("windows")],
    )
    expect((await deletion.references(marker, new Set())).map(String)).toEqual(["mac", "windows"])

    await deletion.acknowledge(marker, SyncEvent.DeviceID.make("mac"))
    await deletion.acknowledge(marker, SyncEvent.DeviceID.make("mac"))
    expect((await deletion.references(marker, new Set())).map(String)).toEqual(["windows"])
    expect(
      await deletion.references(marker, new Set([SyncEvent.DeviceID.make("windows")])),
    ).toEqual([])

    await deletion.remove(marker)
    expect(await deletion.list()).toEqual([])
  })
})

function memory() {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const conflict = (operation: "download" | "upload") =>
    new SyncProvider.ProviderError("memory", operation, "conflict", false)
  const adapter: SyncProvider.Adapter = {
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
        values.delete(object.path)
        return { path: object.path, status: "deleted" as const }
      })
    },
  }
  return { adapter, values }
}
