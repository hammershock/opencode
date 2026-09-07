export * as SyncChunk from "./chunk"

import { Schema } from "effect"
import { SyncCrypto } from "./crypto"
import { NonNegativeInt, PositiveInt } from "../schema"

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

export const Entry = Schema.Struct({
  id: Schema.NonEmptyString,
  size: NonNegativeInt,
})
export type Entry = typeof Entry.Type

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  keyEpoch: PositiveInt,
  totalSize: NonNegativeInt,
  mediaType: Schema.NonEmptyString,
  objectID: Schema.NonEmptyString,
  chunks: Schema.Array(Entry),
})
export type Manifest = typeof Manifest.Type

export type Chunk = Entry & { readonly bytes: Uint8Array }

export class InvalidChunkError extends Error {
  override readonly name = "SyncChunk.InvalidChunkError"
}

export async function split(input: {
  readonly rootKey?: Uint8Array
  readonly objectID?: (bytes: Uint8Array) => Promise<string>
  readonly keyEpoch: number
  readonly bytes: Uint8Array
  readonly mediaType: string
  readonly chunkSize?: number
}): Promise<{ readonly manifest: Manifest; readonly chunks: readonly Chunk[] }> {
  const identify = identity(input)
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new InvalidChunkError("Invalid chunk size")
  if (!input.mediaType) throw new InvalidChunkError("Media type is required")
  const chunks: Chunk[] = []
  for (let offset = 0; offset < input.bytes.length; offset += chunkSize) {
    const bytes = input.bytes.slice(offset, Math.min(offset + chunkSize, input.bytes.length))
    chunks.push({ id: await identify(bytes), size: bytes.length, bytes })
  }
  return {
    manifest: {
      version: 1,
      keyEpoch: input.keyEpoch,
      totalSize: input.bytes.length,
      mediaType: input.mediaType,
      objectID: await identify(input.bytes),
      chunks: chunks.map(({ id, size }) => ({ id, size })),
    },
    chunks,
  }
}

export async function assemble(input: {
  readonly rootKey?: Uint8Array
  readonly objectID?: (bytes: Uint8Array) => Promise<string>
  readonly manifest: unknown
  readonly read: (id: string) => Promise<Uint8Array>
}): Promise<Uint8Array> {
  try {
    const identify = identity({ ...input, keyEpoch: Schema.decodeUnknownSync(Manifest)(input.manifest).keyEpoch })
    const manifest = Schema.decodeUnknownSync(Manifest)(input.manifest)
    const parts: Uint8Array[] = []
    let total = 0
    for (const entry of manifest.chunks) {
      const bytes = await input.read(entry.id)
      if (bytes.length !== entry.size) throw new InvalidChunkError("Chunk size mismatch")
      if ((await identify(bytes)) !== entry.id) throw new InvalidChunkError("Chunk identity mismatch")
      total += bytes.length
      if (total > manifest.totalSize) throw new InvalidChunkError("Chunk total exceeds manifest")
      parts.push(bytes)
    }
    if (total !== manifest.totalSize) throw new InvalidChunkError("Chunk total mismatch")
    const output = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      output.set(part, offset)
      offset += part.length
    }
    if ((await identify(output)) !== manifest.objectID) throw new InvalidChunkError("Object identity mismatch")
    return output
  } catch (error) {
    if (error instanceof InvalidChunkError) throw error
    throw new InvalidChunkError("Invalid chunk manifest")
  }
}

function identity(input: {
  readonly rootKey?: Uint8Array
  readonly objectID?: (bytes: Uint8Array) => Promise<string>
  readonly keyEpoch: number
}) {
  if (input.objectID) return input.objectID
  if (input.rootKey) return (bytes: Uint8Array) => SyncCrypto.objectID(input.rootKey!, input.keyEpoch, bytes)
  throw new InvalidChunkError("Chunk identity is required")
}
