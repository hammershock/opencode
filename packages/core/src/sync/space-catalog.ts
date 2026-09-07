export * as SyncSpaceCatalog from "./space-catalog"

import { Schema } from "effect"
import { SyncCrypto } from "./crypto"
import { SyncProvider } from "./provider"
import { SyncSpace } from "./space"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export class CatalogError extends Error {
  override readonly name = "SyncSpaceCatalog.Error"

  constructor(readonly kind: "deleted" | "conflict" | "not-found" | "unsupported" | "invalid" | "cleanup") {
    super(`Sync space catalog failed: ${kind}`)
  }
}

export type Discovery = {
  readonly spaces: readonly SyncSpace.CatalogEntry[]
  readonly deletions: readonly SyncSpace.Deletion[]
}

export function make(input: {
  readonly provider: SyncProvider.Adapter
  readonly now?: () => number
  readonly createSpace?: () => SyncCrypto.SpaceKey
}) {
  const now = input.now ?? Date.now
  const createSpace = input.createSpace ?? SyncCrypto.createSpace

  const deletion = async (namespaceID: string, signal?: AbortSignal) => {
    const found = await read(input.provider, deletionPath(namespaceID), SyncSpace.Deletion, signal)
    if (found && found.value.namespaceID !== namespaceID) throw new CatalogError("invalid")
    return found
  }

  const descriptor = async (namespaceID: string, signal?: AbortSignal) => {
    const found = await read(input.provider, descriptorPath(namespaceID), SyncSpace.Descriptor, signal)
    if (found && found.value.namespaceID !== namespaceID) throw new CatalogError("invalid")
    return found
  }

  const inspect = async (namespaceID: string, signal?: AbortSignal): Promise<SyncSpace.Inspection> => {
    validateID(namespaceID)
    if (await deletion(namespaceID, signal)) throw new CatalogError("deleted")
    const found = await descriptor(namespaceID, signal)
    if (!found) throw new CatalogError("not-found")
    if (!SyncSpace.compatible(found.value.protocol)) return { status: "unsupported", descriptor: found.value }
    const protocol = await read(input.provider, protocolPath(namespaceID), SyncSpace.RemoteProtocol, signal)
    if (!protocol || !sameProtocol(found.value, protocol.value)) throw new CatalogError("invalid")
    if (await deletion(namespaceID, signal)) throw new CatalogError("deleted")
    return { status: "ready", descriptor: found.value, protocol: protocol.value }
  }

  const discover = async (signal?: AbortSignal): Promise<Discovery> => {
    const [descriptorObjects, deletionObjects] = await Promise.all([
      SyncProvider.listAll(input.provider, "catalog", signal),
      SyncProvider.listAll(input.provider, "deleted-spaces", signal),
    ])
    const deletions = await Promise.all(
      deletionObjects.map(async (object) => {
        const namespaceID = objectID(object.path, "deleted-spaces")
        const value = await decodeObject(input.provider, object, SyncSpace.Deletion, signal)
        if (value.namespaceID !== namespaceID) throw new CatalogError("invalid")
        return value
      }),
    )
    const removed = new Set(deletions.map((item) => item.namespaceID))
    const descriptors = await Promise.all(
      descriptorObjects
        .map((object) => ({ object, namespaceID: objectID(object.path, "catalog") }))
        .filter((item) => !removed.has(item.namespaceID))
        .map(async (item) => {
          const value = await decodeObject(input.provider, item.object, SyncSpace.Descriptor, signal)
          if (value.namespaceID !== item.namespaceID) throw new CatalogError("invalid")
          return value
        }),
    )
    const spaces = descriptors
      .filter((item) => !removed.has(item.namespaceID))
      .map(
        (item): SyncSpace.CatalogEntry =>
          SyncSpace.compatible(item.protocol)
            ? { status: "compatible", descriptor: item }
            : { status: "unsupported", descriptor: item },
      )
      .toSorted(
        (left, right) =>
          left.descriptor.name.localeCompare(right.descriptor.name) ||
          left.descriptor.namespaceID.localeCompare(right.descriptor.namespaceID),
      )
    return {
      spaces,
      deletions: deletions.toSorted((left, right) => left.namespaceID.localeCompare(right.namespaceID)),
    }
  }

  const create = async (
    values: { readonly name: string; readonly encryption?: SyncSpace.Encryption },
    signal?: AbortSignal,
  ) => {
    const generated = createSpace()
    const timestamp = now()
    const space: SyncSpace.Descriptor = {
      namespaceID: generated.namespaceID,
      name: values.name.trim(),
      protocol: { major: 1, minor: 0 },
      encryption: values.encryption ?? "none",
      createdAt: timestamp,
      updatedAt: timestamp,
      summary: { sessions: 0, devices: 0, updatedAt: timestamp },
      revision: 1,
    }
    decode(SyncSpace.Descriptor, space)
    if (await deletion(space.namespaceID, signal)) throw new CatalogError("deleted")
    await ensure(input.provider, protocolPath(space.namespaceID), protocolFrom(space), signal)
    if (await deletion(space.namespaceID, signal)) throw new CatalogError("deleted")
    await ensure(input.provider, descriptorPath(space.namespaceID), space, signal)
    if (await deletion(space.namespaceID, signal)) throw new CatalogError("deleted")
    return {
      descriptor: space,
      ...(space.encryption === "aes-256-gcm"
        ? { recoveryString: await SyncCrypto.exportRecoveryString(generated) }
        : {}),
    }
  }

  const join = async (namespaceID: string, signal?: AbortSignal) => {
    const found = await inspect(namespaceID, signal)
    if (found.status === "unsupported") throw new CatalogError("unsupported")
    return found
  }

  const remove = async (namespaceID: string, signal?: AbortSignal) => {
    validateID(namespaceID)
    const existing = await deletion(namespaceID, signal)
    const marker =
      existing?.value ?? (await publishDeletion(input.provider, { namespaceID, deletedAt: now(), revision: 1 }, signal))
    const objects = await SyncProvider.listAll(input.provider, spacePrefix(namespaceID), signal).catch(() => {
      throw new CatalogError("cleanup")
    })
    const descriptorObject = await input.provider.stat(descriptorPath(namespaceID), signal).catch(() => undefined)
    const results = await input.provider
      .deleteBatch(
        [
          ...objects.map((object) => ({ path: object.path, version: object.version })),
          ...(descriptorObject ? [{ path: descriptorObject.path, version: descriptorObject.version }] : []),
        ],
        signal,
      )
      .catch(() => {
        throw new CatalogError("cleanup")
      })
    if (results.some((result) => result.status === "conflict")) throw new CatalogError("cleanup")
    return marker
  }

  return { discover, inspect, join, create, remove }
}

function descriptorPath(namespaceID: string) {
  validateID(namespaceID)
  return `catalog/${namespaceID}.json`
}

function deletionPath(namespaceID: string) {
  validateID(namespaceID)
  return `deleted-spaces/${namespaceID}.json`
}

function spacePrefix(namespaceID: string) {
  validateID(namespaceID)
  return `spaces/${namespaceID}`
}

function protocolPath(namespaceID: string) {
  return `${spacePrefix(namespaceID)}/protocol.json`
}

function objectID(path: string, prefix: "catalog" | "deleted-spaces") {
  const match = new RegExp(`^${prefix}/([A-Za-z0-9_-]+)\\.json$`).exec(path)
  if (!match) throw new CatalogError("invalid")
  return match[1]!
}

function validateID(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new CatalogError("invalid")
}

function protocolFrom(descriptor: SyncSpace.Descriptor): SyncSpace.RemoteProtocol {
  return {
    namespaceID: descriptor.namespaceID,
    protocol: descriptor.protocol,
    encryption: descriptor.encryption,
    createdAt: descriptor.createdAt,
  }
}

function sameProtocol(descriptor: SyncSpace.Descriptor, protocol: SyncSpace.RemoteProtocol) {
  return (
    descriptor.namespaceID === protocol.namespaceID &&
    descriptor.protocol.major === protocol.protocol.major &&
    descriptor.protocol.minor === protocol.protocol.minor &&
    descriptor.encryption === protocol.encryption &&
    descriptor.createdAt === protocol.createdAt
  )
}

async function ensure(provider: SyncProvider.Adapter, path: string, value: unknown, signal?: AbortSignal) {
  const bytes = encode(value)
  await provider.uploadAtomic(path, bytes, { type: "absent" }, signal).catch(async (cause) => {
    if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict") throw cause
    const found = await provider.stat(path, signal)
    if (!found) throw new CatalogError("conflict")
    const remote = await provider.download(path, found.version, signal)
    if (!Buffer.from(remote.bytes).equals(Buffer.from(bytes))) throw new CatalogError("conflict")
  })
}

async function publishDeletion(provider: SyncProvider.Adapter, marker: SyncSpace.Deletion, signal?: AbortSignal) {
  const path = deletionPath(marker.namespaceID)
  try {
    await provider.uploadAtomic(path, encode(marker), { type: "absent" }, signal)
    return marker
  } catch (cause) {
    if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict") throw cause
    const winner = await read(provider, path, SyncSpace.Deletion, signal)
    if (!winner || winner.value.namespaceID !== marker.namespaceID) throw new CatalogError("conflict")
    return winner.value
  }
}

async function read<S extends Schema.Decoder<unknown>>(
  provider: SyncProvider.Adapter,
  path: string,
  schema: S,
  signal?: AbortSignal,
) {
  const info = await provider.stat(path, signal)
  if (!info) return
  return { value: decode(schema, (await provider.download(path, info.version, signal)).bytes), info }
}

async function decodeObject<S extends Schema.Decoder<unknown>>(
  provider: SyncProvider.Adapter,
  object: SyncProvider.ObjectInfo,
  schema: S,
  signal?: AbortSignal,
) {
  return decode(schema, (await provider.download(object.path, object.version, signal)).bytes)
}

function encode(value: unknown) {
  return encoder.encode(JSON.stringify(value))
}

function decode<S extends Schema.Decoder<unknown>>(schema: S, value: unknown): S["Type"] {
  try {
    const parsed = value instanceof Uint8Array ? JSON.parse(decoder.decode(value)) : value
    return Schema.decodeUnknownSync(schema)(parsed)
  } catch {
    throw new CatalogError("invalid")
  }
}
