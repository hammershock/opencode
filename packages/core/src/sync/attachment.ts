export * as SyncAttachment from "./attachment"

import { Schema } from "effect"
import { SyncChunk } from "./chunk"
import { SyncCrypto } from "./crypto"
import { SyncProvider } from "./provider"
import { SyncCodec } from "./codec"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

/**
 * Durable Session events are JSON. Binary file parts therefore arrive as data
 * URLs and tool output can occasionally be substantially larger than an event
 * segment should be.  The wire representation is deliberately a string: the
 * normal Session schemas continue to accept it while it is at rest, and it is
 * expanded back to its original JSON value before EventV2 replays it.
 */
const referencePrefix = "opencode-sync-attachment://"
const inlineTextThreshold = 128 * 1024

export interface Interface {
  readonly put: (bytes: Uint8Array, mediaType: string, signal?: AbortSignal) => Promise<string>
  readonly get: (objectID: string, signal?: AbortSignal) => Promise<Uint8Array>
  readonly collect: (input: {
    readonly liveObjectIDs: ReadonlySet<string>
    readonly allActiveDevicesAcknowledged: boolean
    readonly signal?: AbortSignal
  }) => Promise<{ readonly deleted: number; readonly deferred: boolean }>
}

type Reference = {
  readonly objectID: string
  readonly mediaType: string
  readonly encoding: "base64" | "utf8"
}

/** IDs referenced by an encoded durable payload, used by ACK-gated GC. */
export function references(value: unknown): ReadonlySet<string> {
  const found = new Set<string>()
  visit(value, (item) => {
    if (typeof item !== "string") return
    const reference = parseReference(item)
    if (reference) found.add(reference.objectID)
  })
  return found
}

/**
 * Replaces only payloads OpenCode actually persists in Session parts: data
 * URLs (including tool attachments) and very large `output`/`raw` strings.
 * It never follows file paths or arbitrary URLs, so syncing does not upload
 * workspace files merely because a tool mentioned them.
 */
export async function externalize(value: unknown, attachment: Pick<Interface, "put">): Promise<unknown> {
  return transform(value, async (item, key) => {
    if (typeof item !== "string" || parseReference(item)) return item
    const data = parseDataURL(item)
    if (data) {
      const objectID = await attachment.put(data.bytes, data.mediaType)
      return formatReference({ objectID, mediaType: data.mediaType, encoding: "base64" })
    }
    if ((key === "output" || key === "raw") && encoder.encode(item).byteLength >= inlineTextThreshold) {
      const objectID = await attachment.put(encoder.encode(item), "text/plain; charset=utf-8")
      return formatReference({ objectID, mediaType: "text/plain; charset=utf-8", encoding: "utf8" })
    }
    return item
  })
}

/** Expands attachment references before a remote event reaches EventV2. */
export async function hydrate(value: unknown, attachment: Pick<Interface, "get">): Promise<unknown> {
  return transform(value, async (item) => {
    if (typeof item !== "string") return item
    const reference = parseReference(item)
    if (!reference) return item
    const bytes = await attachment.get(reference.objectID)
    if (reference.encoding === "base64")
      return `data:${reference.mediaType};base64,${Buffer.from(bytes).toString("base64")}`
    return decoder.decode(bytes)
  })
}

export function make(input: {
  readonly rootKey?: Uint8Array
  readonly codec?: SyncCodec.Interface
  readonly namespaceID: string
  readonly provider: SyncProvider.Adapter
}): Interface {
  const codec = input.codec ?? (input.rootKey ? SyncCodec.encrypted(input.rootKey) : undefined)
  if (!codec) throw new Error("SyncAttachment requires a codec or root key")
  const context = (path: string, type: string): SyncCrypto.ObjectContext => ({
    path,
    type,
    deviceID: input.namespaceID,
    generation: 0,
    range: "attachment",
    schemaVersion: 1,
  })
  const seal = async (path: string, type: "chunk" | "manifest", value: Uint8Array) =>
    codec.seal("attachment", context(path, type), value)
  const open = async (path: string, type: "chunk" | "manifest", value: Uint8Array) =>
    codec.open("attachment", context(path, type), value)

  const put = async (bytes: Uint8Array, mediaType: string, signal?: AbortSignal) => {
    const split = await SyncChunk.split({ objectID: codec.objectID, keyEpoch: 1, bytes, mediaType })
    for (const chunk of new Map(split.chunks.map((item) => [item.id, item])).values()) {
      const path = chunkPath(chunk.id, codec.suffix)
      const existing = await input.provider.stat(path, signal)
      if (existing) {
        const downloaded = await input.provider.download(path, existing.version, signal)
        const plaintext = await open(path, "chunk", downloaded.bytes)
        if ((await codec.objectID(plaintext)) !== chunk.id)
          throw new SyncChunk.InvalidChunkError("Existing chunk is corrupt")
        continue
      }
      await input.provider.uploadAtomic(path, await seal(path, "chunk", chunk.bytes), { type: "absent" }, signal)
    }
    const path = manifestPath(split.manifest.objectID, codec.suffix)
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
    const path = manifestPath(objectID, codec.suffix)
    const info = await input.provider.stat(path, signal)
    if (!info) throw new SyncChunk.InvalidChunkError("Attachment manifest is missing")
    const downloaded = await input.provider.download(path, info.version, signal)
    const manifest = Schema.decodeUnknownSync(SyncChunk.Manifest)(
      JSON.parse(decoder.decode(await open(path, "manifest", downloaded.bytes))),
    )
    return SyncChunk.assemble({
      objectID: codec.objectID,
      manifest,
      read: async (id) => {
        const path = chunkPath(id, codec.suffix)
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
      const id = new RegExp(`^chunks/manifests/(.+)\\${codec.suffix}$`).exec(item.path)?.[1]
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
      const id = new RegExp(`^chunks/manifests/(.+)\\${codec.suffix}$`).exec(item.path)?.[1]
      return id && !inputGC.liveObjectIDs.has(id)
    })
    const chunks = await SyncProvider.listAll(input.provider, "chunks", inputGC.signal)
    const staleChunks = chunks.filter((item) => {
      const id = new RegExp(`^chunks/([^/]+)\\${codec.suffix}$`).exec(item.path)?.[1]
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

function chunkPath(id: string, suffix: SyncCodec.Interface["suffix"]) {
  return SyncProvider.objectPath(`chunks/${id}${suffix}`)
}

function manifestPath(id: string, suffix: SyncCodec.Interface["suffix"]) {
  return SyncProvider.objectPath(`chunks/manifests/${id}${suffix}`)
}

function formatReference(reference: Reference) {
  const query = new URLSearchParams({ mime: reference.mediaType, encoding: reference.encoding })
  return `${referencePrefix}${encodeURIComponent(reference.objectID)}?${query}`
}

function parseReference(value: string): Reference | undefined {
  if (!value.startsWith(referencePrefix)) return
  try {
    const url = new URL(value)
    const objectID = decodeURIComponent(url.hostname)
    const mediaType = url.searchParams.get("mime")
    const encoding = url.searchParams.get("encoding")
    if (!objectID || !mediaType || (encoding !== "base64" && encoding !== "utf8")) return
    return { objectID, mediaType, encoding }
  } catch {
    return
  }
}

function parseDataURL(value: string): { readonly mediaType: string; readonly bytes: Uint8Array } | undefined {
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(value)
  if (!match?.[1] || match[2] === undefined) return
  try {
    return { mediaType: match[1], bytes: new Uint8Array(Buffer.from(match[2], "base64")) }
  } catch {
    return
  }
}

async function transform(
  value: unknown,
  leaf: (value: unknown, key?: string) => Promise<unknown>,
  key?: string,
): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => transform(item, leaf)))
  if (value && typeof value === "object") {
    const entries = await Promise.all(
      Object.entries(value as Record<string, unknown>).map(async ([childKey, item]) => [
        childKey,
        await transform(item, leaf, childKey),
      ]),
    )
    return Object.fromEntries(entries)
  }
  return leaf(value, key)
}

function visit(value: unknown, fn: (value: unknown) => void) {
  fn(value)
  if (Array.isArray(value)) {
    for (const item of value) visit(item, fn)
    return
  }
  if (value && typeof value === "object")
    for (const item of Object.values(value as Record<string, unknown>)) visit(item, fn)
}
