import { describe, expect, test } from "bun:test"
import { SyncAttachment } from "@opencode-ai/core/sync/attachment"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncCodec } from "@opencode-ai/core/sync/codec"

function provider() {
  const files = new Map<string, Uint8Array>()
  const adapter: SyncProvider.Adapter = {
    id: "memory",
    list: async (prefix) => ({
      objects: [...files]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, bytes]) => ({ path, version: "1", size: bytes.length })),
    }),
    stat: async (path) => (files.has(path) ? { path, version: "1", size: files.get(path)!.length } : undefined),
    download: async (path) => ({ path, version: "1", size: files.get(path)!.length, bytes: files.get(path)! }),
    uploadAtomic: async (path, bytes) => {
      files.set(path, bytes.slice())
      return { path, version: "1", size: bytes.length }
    },
    deleteBatch: async (objects) =>
      objects.map(({ path }) => {
        files.delete(path)
        return { path, status: "deleted" as const }
      }),
  }
  return { files, adapter }
}

describe("SyncAttachment", () => {
  test("stores and validates attachments in plaintext spaces without a key", async () => {
    const remote = provider()
    const service = SyncAttachment.make({
      codec: SyncCodec.plaintext(),
      namespaceID: "space",
      provider: remote.adapter,
    })
    const bytes = new TextEncoder().encode("plain attachment")
    const id = await service.put(bytes, "text/plain")
    expect([...remote.files.keys()].every((item) => item.endsWith(".json"))).toBeTrue()
    expect(await service.get(id)).toEqual(bytes)
  })

  test("encrypts, deduplicates and hydrates persisted attachment payloads", async () => {
    const remote = provider()
    const service = SyncAttachment.make({
      rootKey: SyncCrypto.createSpace().rootKey,
      namespaceID: "space",
      provider: remote.adapter,
    })
    const bytes = new TextEncoder().encode("private attachment")
    const id = await service.put(bytes, "text/plain")
    const count = remote.files.size
    expect(new TextDecoder().decode(Buffer.concat([...remote.files.values()].map(Buffer.from)))).not.toContain(
      "private attachment",
    )
    expect(await service.put(bytes, "text/plain")).toBe(id)
    expect(remote.files.size).toBe(count)
    expect(await service.get(id)).toEqual(bytes)
  })

  test("defers garbage collection until every active device acknowledged", async () => {
    const remote = provider()
    const service = SyncAttachment.make({
      rootKey: SyncCrypto.createSpace().rootKey,
      namespaceID: "space",
      provider: remote.adapter,
    })
    await service.put(new Uint8Array([1]), "application/octet-stream")
    expect((await service.collect({ liveObjectIDs: new Set(), allActiveDevicesAcknowledged: false })).deferred).toBe(
      true,
    )
    expect(remote.files.size).toBeGreaterThan(0)
    expect((await service.collect({ liveObjectIDs: new Set(), allActiveDevicesAcknowledged: true })).deleted).toBe(2)
    expect(remote.files.size).toBe(0)
  })

  test("externalizes real Session file parts and tool output, then restores them before replay", async () => {
    const remote = provider()
    const service = SyncAttachment.make({
      rootKey: SyncCrypto.createSpace().rootKey,
      namespaceID: "space",
      provider: remote.adapter,
    })
    const original = {
      sessionID: "session-1",
      part: {
        type: "tool",
        state: {
          status: "completed",
          output: "x".repeat(128 * 1024),
          attachments: [
            {
              type: "file",
              mime: "image/png",
              url: "data:image/png;base64,aGVsbG8=",
            },
          ],
        },
      },
    }
    const encoded = await SyncAttachment.externalize(original, service)
    expect(JSON.stringify(encoded)).not.toContain("aGVsbG8=")
    expect(JSON.stringify(encoded)).not.toContain('"output":"' + "x".repeat(100))
    expect(SyncAttachment.references(encoded).size).toBe(2)
    expect(await SyncAttachment.hydrate(encoded, service)).toEqual(original)
  })

  test("does not treat workspace paths or ordinary URLs as sync attachments", async () => {
    const calls: string[] = []
    const value = await SyncAttachment.externalize(
      {
        url: "file:///private/project/image.png",
        remote: "https://example.com/image.png",
        output: "short output",
      },
      {
        put: async (bytes) => {
          calls.push(new TextDecoder().decode(bytes))
          return "object"
        },
      },
    )
    expect(value).toEqual({
      url: "file:///private/project/image.png",
      remote: "https://example.com/image.png",
      output: "short output",
    })
    expect(calls).toEqual([])
  })
})
