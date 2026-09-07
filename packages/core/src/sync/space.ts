export * as SyncSpace from "./space"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export const Protocol = Schema.Struct({ major: Schema.Literal(1), minor: NonNegativeInt })
export type Protocol = typeof Protocol.Type
export const Encryption = Schema.Literals(["none", "aes-256-gcm"])
export type Encryption = typeof Encryption.Type

export const Summary = Schema.Struct({
  sessions: NonNegativeInt,
  devices: NonNegativeInt,
  updatedAt: NonNegativeInt,
})
export type Summary = typeof Summary.Type

export const Descriptor = Schema.Struct({
  namespaceID: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  protocol: Protocol,
  encryption: Encryption,
  createdAt: NonNegativeInt,
  updatedAt: NonNegativeInt,
  summary: Summary,
  revision: NonNegativeInt,
})
export type Descriptor = typeof Descriptor.Type

export const Deletion = Schema.Struct({
  namespaceID: Schema.NonEmptyString,
  deletedAt: NonNegativeInt,
  revision: NonNegativeInt,
})
export type Deletion = typeof Deletion.Type

export const Catalog = Schema.Struct({
  version: Schema.Literal(1),
  revision: NonNegativeInt,
  spaces: Schema.Array(Descriptor),
  deletions: Schema.Array(Deletion),
})
export type Catalog = typeof Catalog.Type

export const empty = (): Catalog => ({ version: 1, revision: 0, spaces: [], deletions: [] })

export function compatible(protocol: Protocol) {
  return protocol.major === 1 && protocol.minor <= 0
}

export function merge(left: Catalog, right: Catalog): Catalog {
  const deletions = newest([...left.deletions, ...right.deletions])
  const removed = new Set(deletions.map((item) => item.namespaceID))
  const spaces = newest([...left.spaces, ...right.spaces]).filter((space) => !removed.has(space.namespaceID))
  return {
    version: 1,
    revision: Math.max(left.revision, right.revision),
    spaces: spaces.toSorted((a, b) => a.name.localeCompare(b.name) || a.namespaceID.localeCompare(b.namespaceID)),
    deletions: deletions.toSorted((a, b) => a.namespaceID.localeCompare(b.namespaceID)),
  }
}

export function put(catalog: Catalog, descriptor: Descriptor): Catalog {
  if (catalog.deletions.some((item) => item.namespaceID === descriptor.namespaceID))
    throw new Error("Deleted sync namespace IDs cannot be reused")
  const next = merge(catalog, { version: 1, revision: descriptor.revision, spaces: [descriptor], deletions: [] })
  return { ...next, revision: Math.max(catalog.revision + 1, descriptor.revision) }
}

export function remove(catalog: Catalog, namespaceID: string, deletedAt = Date.now()): Catalog {
  const revision = catalog.revision + 1
  const next = merge(catalog, {
    version: 1,
    revision,
    spaces: [],
    deletions: [{ namespaceID, deletedAt, revision }],
  })
  return { ...next, revision }
}

function newest<T extends { readonly namespaceID: string; readonly revision: number }>(items: readonly T[]) {
  return [
    ...new Map(items.toSorted((a, b) => a.revision - b.revision).map((item) => [item.namespaceID, item])).values(),
  ]
}
