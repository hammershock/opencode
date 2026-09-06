import { describe, expect, test } from "bun:test"
import { SyncChunk } from "@opencode-ai/core/sync/chunk"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"

describe("SyncChunk", () => {
  test("splits, deduplicates and reconstructs an ordered payload", async () => {
    const rootKey = SyncCrypto.createSpace().rootKey
    const bytes = new TextEncoder().encode("abcdabcd")
    const result = await SyncChunk.split({ rootKey, keyEpoch: 1, bytes, mediaType: "text/plain", chunkSize: 4 })
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0]!.id).toBe(result.chunks[1]!.id)
    expect(result.manifest).toMatchObject({ totalSize: 8, mediaType: "text/plain" })
    const byID = new Map(result.chunks.map((chunk) => [chunk.id, chunk.bytes]))
    expect(await SyncChunk.assemble({ rootKey, manifest: result.manifest, read: async (id) => byID.get(id)! })).toEqual(
      bytes,
    )
  })

  test("supports empty persisted payloads without inventing a chunk", async () => {
    const rootKey = SyncCrypto.createSpace().rootKey
    const result = await SyncChunk.split({
      rootKey,
      keyEpoch: 1,
      bytes: new Uint8Array(),
      mediaType: "application/octet-stream",
    })
    expect(result.chunks).toEqual([])
    expect(
      await SyncChunk.assemble({ rootKey, manifest: result.manifest, read: async () => new Uint8Array() }),
    ).toEqual(new Uint8Array())
  })

  test("rejects reordered, missing, changed and wrong-key chunks", async () => {
    const rootKey = SyncCrypto.createSpace().rootKey
    const bytes = new TextEncoder().encode("abcdefgh")
    const result = await SyncChunk.split({ rootKey, keyEpoch: 2, bytes, mediaType: "text/plain", chunkSize: 4 })
    const byID = new Map(result.chunks.map((chunk) => [chunk.id, chunk.bytes]))
    const run = (manifest: unknown, key = rootKey, read = async (id: string) => byID.get(id)!) =>
      SyncChunk.assemble({ rootKey: key, manifest, read })

    await expect(run({ ...result.manifest, chunks: [...result.manifest.chunks].reverse() })).rejects.toBeInstanceOf(
      SyncChunk.InvalidChunkError,
    )
    await expect(run({ ...result.manifest, chunks: result.manifest.chunks.slice(0, 1) })).rejects.toBeInstanceOf(
      SyncChunk.InvalidChunkError,
    )
    await expect(run(result.manifest, rootKey, async () => new TextEncoder().encode("xxxx"))).rejects.toBeInstanceOf(
      SyncChunk.InvalidChunkError,
    )
    await expect(run(result.manifest, SyncCrypto.createSpace().rootKey)).rejects.toBeInstanceOf(
      SyncChunk.InvalidChunkError,
    )
  })
})
