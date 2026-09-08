export * as SyncDeletion from "./deletion"

import { Schema } from "effect"
import { NonNegativeInt } from "../schema"
import { SyncEvent } from "./event"
import { SyncProvider } from "./provider"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const Marker = Schema.Struct({
  version: Schema.Literal(1),
  tombstone: SyncEvent.Tombstone,
  requiredDevices: Schema.Array(SyncEvent.DeviceID),
  publishedAt: NonNegativeInt,
})
export type Marker = typeof Marker.Type

export const Acknowledgement = Schema.Struct({
  version: Schema.Literal(1),
  tombstoneID: Schema.NonEmptyString,
  deviceID: SyncEvent.DeviceID,
  acknowledgedAt: NonNegativeInt,
})
export type Acknowledgement = typeof Acknowledgement.Type

export function make(input: { readonly provider: SyncProvider.Adapter; readonly now?: () => number }) {
  const now = input.now ?? Date.now

  const list = async (signal?: AbortSignal) => {
    const objects = await SyncProvider.listAll(input.provider, "deletions", signal)
    return Promise.all(
      objects
        .filter((item) => /^deletions\/[^/]+\/marker\.json$/.test(item.path))
        .map(async (item) => decode(Marker, (await input.provider.download(item.path, item.version, signal)).bytes)),
    )
  }

  const ensure = async (
    tombstone: SyncEvent.Tombstone,
    requiredDevices: readonly SyncEvent.DeviceID[],
    signal?: AbortSignal,
  ) => {
    const marker = Marker.make({
      version: 1,
      tombstone,
      requiredDevices: [...new Set(requiredDevices)].sort((left, right) => String(left).localeCompare(String(right))),
      publishedAt: now(),
    })
    const path = markerPath(tombstone.sessionID)
    try {
      await input.provider.uploadAtomic(path, encode(marker), { type: "absent" }, signal)
      return marker
    } catch (cause) {
      if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict") throw cause
      const object = await input.provider.stat(path, signal)
      if (!object) throw cause
      return decode(Marker, (await input.provider.download(path, object.version, signal)).bytes)
    }
  }

  const acknowledge = async (marker: Marker, deviceID: SyncEvent.DeviceID, signal?: AbortSignal) => {
    if (!marker.requiredDevices.includes(deviceID)) return
    const acknowledgement = Acknowledgement.make({
      version: 1,
      tombstoneID: marker.tombstone.id,
      deviceID,
      acknowledgedAt: now(),
    })
    const path = acknowledgementPath(marker.tombstone.sessionID, deviceID)
    try {
      await input.provider.uploadAtomic(path, encode(acknowledgement), { type: "absent" }, signal)
    } catch (cause) {
      if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict") throw cause
      const object = await input.provider.stat(path, signal)
      if (!object) throw cause
      const existing = decode(Acknowledgement, (await input.provider.download(path, object.version, signal)).bytes)
      if (existing.tombstoneID !== marker.tombstone.id || existing.deviceID !== deviceID) throw cause
    }
  }

  const references = async (
    marker: Marker,
    revoked: ReadonlySet<SyncEvent.DeviceID>,
    signal?: AbortSignal,
  ) => {
    const objects = await SyncProvider.listAll(input.provider, acknowledgementPrefix(marker.tombstone.sessionID), signal)
    const acknowledged = new Set(
      (
        await Promise.all(
          objects.map(async (item) =>
            decode(Acknowledgement, (await input.provider.download(item.path, item.version, signal)).bytes),
          ),
        )
      )
        .filter((item) => item.tombstoneID === marker.tombstone.id)
        .map((item) => item.deviceID),
    )
    return marker.requiredDevices.filter((deviceID) => !acknowledged.has(deviceID) && !revoked.has(deviceID))
  }

  const remove = async (marker: Marker, signal?: AbortSignal) => {
    const objects = await SyncProvider.listAll(input.provider, acknowledgementPrefix(marker.tombstone.sessionID), signal)
    const markerObject = await input.provider.stat(markerPath(marker.tombstone.sessionID), signal)
    const values = [...objects, ...(markerObject ? [markerObject] : [])]
    if (!values.length) return
    const result = await input.provider.deleteBatch(
      values.map((item) => ({ path: item.path, version: item.version })),
      signal,
    )
    if (result.some((item) => item.status === "conflict"))
      throw new SyncProvider.ProviderError(input.provider.id, "delete", "conflict", true)
  }

  return { list, ensure, acknowledge, references, remove }
}

function markerPath(sessionID: string) {
  validateID(sessionID)
  return SyncProvider.objectPath(`deletions/${sessionID}/marker.json`)
}

function acknowledgementPrefix(sessionID: string) {
  validateID(sessionID)
  return SyncProvider.objectPath(`deletions/${sessionID}/acks`)
}

function acknowledgementPath(sessionID: string, deviceID: SyncEvent.DeviceID) {
  validateID(String(deviceID))
  return SyncProvider.objectPath(`${acknowledgementPrefix(sessionID)}/${deviceID}.json`)
}

function validateID(value: string) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid sync identity")
}

function encode(value: Marker | Acknowledgement) {
  return encoder.encode(JSON.stringify(value))
}

function decode<S extends Schema.Decoder<unknown>>(schema: S, value: Uint8Array): S["Type"] {
  return Schema.decodeUnknownSync(schema)(JSON.parse(decoder.decode(value)))
}
