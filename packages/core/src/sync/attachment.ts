export * as SyncAttachment from "./attachment"

import { Schema } from "effect"
import { SyncChunk } from "./chunk"
import { SyncCrypto } from "./crypto"
import { SyncProvider } from "./provider"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export function make(input: {
  readonly rootKey: Uint8Array
  readonly namespaceID: string
  readonly provider: SyncProvider.Adapter
}) {
  const context = (path: string, type: string): SyncCrypto.ObjectContext => ({
    path,
    type,
    deviceID: input.namespaceID,
    generation: 0,
    range: "attachment",
    schemaVersion: 1,
  })
  const seal = async (path: string, type: "chunk" | "manifest", value: Uint8Array) =>
    encoder.encode(JSON.stringify(await SyncCrypto.encrypt(input.rootKey, "attachment", 1, context(path, type), value)))
  const open = async (path: string, type: "chunk" | "manifest", value: Uint8Array) =>
    SyncCrypto.decrypt(input.rootKey, "attachment", context(path, type), JSON.parse(decoder.decode(value)))

  const put = async (bytes: Uint8Array, mediaType: string, signal?: AbortSignal) => {
    const split = await SyncChunk.split({ rootKey: input.rootKey, keyEpoch: 1, bytes, mediaType })
    for (const chunk of new Map(split.chunks.map((item) => [item.id, item])).values()) {
      const path = chunkPath(chunk.id)
      const existing = await input.provider.stat(path, signal)
      if (existing) {
        const downloaded = await input.provider.download(path, existing.version, signal)
        const plaintext = await open(path, "chunk", downloaded.bytes)
        if ((await SyncCrypto.objectID(input.rootKey, 1, plaintext)) !== chunk.id)
          throw new SyncChunk.InvalidChunkError("Existing encrypted chunk is corrupt")
        continue
      }
      await input.provider.uploadAtomic(path, await seal(path, "chunk", chunk.bytes), { type: "absent" }, signal)
    }
    const path = manifestPath(split.manifest.objectID)
    if (!(await input.provider.stat(path, signal)))
      await input.provider.uploadAtomic(
        path,
        await seal(path, "manifest", encoder.encode(JSON.stringify(split.manifest))),
        { type: "absent" },
        signal,
      )
    return split.manifest.objectID
  }

  const get = async (objectID: string, signal?: AbortSignal) => {
    const path = manifestPath(objectID)
    const info = await input.provider.stat(path, signal)
    if (!info) throw new SyncChunk.InvalidChunkError("Attachment manifest is missing")
    const downloaded = await input.provider.download(path, info.version, signal)
    const manifest = Schema.decodeUnknownSync(SyncChunk.Manifest)(
      JSON.parse(decoder.decode(await open(path, "manifest", downloaded.bytes))),
    )
    return SyncChunk.assemble({
      rootKey: input.rootKey,
      manifest,
      read: async (id) => {
        const path = chunkPath(id)
        const info = await input.provider.stat(path, signal)
        if (!info) throw new SyncChunk.InvalidChunkError("Attachment chunk is missing")
        return open(path, "chunk", (await input.provider.download(path, info.version, signal)).bytes)
      },
    })
  }

  const collect = async (inputGC: {
    readonly liveObjectIDs: ReadonlySet<string>
    readonly allActiveDevicesAcknowledged: boolean
    readonly signal?: AbortSignal
  }) => {
    if (!inputGC.allActiveDevicesAcknowledged) return { deleted: 0, deferred: true }
    const manifests = await SyncProvider.listAll(input.provider, "chunks/manifests", inputGC.signal)
    const referenced = new Set<string>()
    for (const item of manifests) {
      const id = /^chunks\/manifests\/(.+)\.enc$/.exec(item.path)?.[1]
      if (!id || !inputGC.liveObjectIDs.has(id)) continue
      const manifest = Schema.decodeUnknownSync(SyncChunk.Manifest)(
        JSON.parse(
          decoder.decode(
            await open(
              item.path,
              "manifest",
              (await input.provider.download(item.path, item.version, inputGC.signal)).bytes,
            ),
          ),
        ),
      )
      for (const chunk of manifest.chunks) referenced.add(chunk.id)
    }
    const stale = manifests.filter((item) => {
      const id = /^chunks\/manifests\/(.+)\.enc$/.exec(item.path)?.[1]
      return id && !inputGC.liveObjectIDs.has(id)
    })
    const chunks = await SyncProvider.listAll(input.provider, "chunks", inputGC.signal)
    const staleChunks = chunks.filter((item) => {
      const id = /^chunks\/([^/]+)\.enc$/.exec(item.path)?.[1]
      return id && !referenced.has(id)
    })
    const remove = [...stale, ...staleChunks]
    const result = remove.length ? await input.provider.deleteBatch(remove, inputGC.signal) : []
    return {
      deleted: result.filter((item) => item.status === "deleted" || item.status === "missing").length,
      deferred: false,
    }
  }

  return { put, get, collect }
}

function chunkPath(id: string) {
  return SyncProvider.objectPath(`chunks/${id}.enc`)
}

function manifestPath(id: string) {
  return SyncProvider.objectPath(`chunks/manifests/${id}.enc`)
}
