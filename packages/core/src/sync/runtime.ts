export * as SyncRuntime from "./runtime"

import { Effect, Schema } from "effect"
import { SyncCrypto } from "./crypto"
import { SyncEvent } from "./event"
import { SyncEventStore } from "./event-store"
import { SyncProvider } from "./provider"
import { NonNegativeInt } from "../schema"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const Metadata = Schema.Struct({
  sessionID: Schema.NonEmptyString,
  title: Schema.String,
  ownerDeviceID: Schema.NonEmptyString,
  targetLabel: Schema.optional(Schema.String),
  directory: Schema.String,
  revision: NonNegativeInt,
  updatedAt: NonNegativeInt,
  deleted: Schema.optional(Schema.Boolean),
})
export type Metadata = typeof Metadata.Type

export const Head = Schema.Struct({
  version: Schema.Literal(1),
  deviceID: SyncEvent.DeviceID,
  deviceName: Schema.NonEmptyString,
  generation: NonNegativeInt,
  acknowledged: Schema.Record(Schema.String, NonNegativeInt),
  metadata: Schema.Array(Metadata),
  revoked: Schema.Array(SyncEvent.DeviceID),
})
export type Head = typeof Head.Type

export type Status = {
  readonly enabled: boolean
  readonly running: "idle" | "upload" | "pull"
  readonly lastUploadAt?: number
  readonly lastPullAt?: number
  readonly lastError?: { readonly stage: "upload" | "pull"; readonly retryable: boolean; readonly message: string }
}

export interface MetadataProjector {
  readonly apply: (metadata: readonly Metadata[], deviceID: SyncEvent.DeviceID) => Effect.Effect<void, unknown>
}

export function make(input: {
  readonly config: { readonly deviceID: SyncEvent.DeviceID; readonly deviceName?: string; readonly enabled: boolean }
  readonly rootKey: Uint8Array
  readonly provider: SyncProvider.Adapter
  readonly store: SyncEventStore.Interface
  readonly projector: SyncEvent.DurableProjector | ((deviceID: SyncEvent.DeviceID) => SyncEvent.DurableProjector)
  readonly metadata: () => Effect.Effect<readonly Metadata[], unknown>
  readonly metadataProjector: MetadataProjector
  readonly acknowledged?: () => Effect.Effect<Readonly<Record<string, number>>, unknown>
  readonly revoked?: () => Effect.Effect<readonly SyncEvent.DeviceID[], unknown>
  readonly deviceProjector?: (head: Head) => Effect.Effect<void, unknown>
  readonly now?: () => number
  readonly owner?: string
}) {
  const now = input.now ?? Date.now
  const owner = input.owner ?? `${process.pid}:${crypto.randomUUID()}`
  let status: Status = { enabled: input.config.enabled, running: "idle" }
  let uploadFlight: Promise<void> | undefined
  let pullFlight: Promise<void> | undefined
  let hydrateFlight: Promise<void> | undefined
  let indexedHeads: readonly Head[] = []
  const projectors = new Map<SyncEvent.DeviceID, SyncEvent.DurableProjector>()
  const projector = (deviceID: SyncEvent.DeviceID) => {
    if (typeof input.projector !== "function") return input.projector
    const found = projectors.get(deviceID)
    if (found) return found
    const created = input.projector(deviceID)
    projectors.set(deviceID, created)
    return created
  }

  const uploadOnce = async (signal?: AbortSignal) => {
    if (!status.enabled) return
    const acquired = await Effect.runPromise(input.store.acquire("upload", owner, 60_000, now()))
    if (!acquired) return
    status = { ...status, running: "upload" }
    try {
      const segment = await Effect.runPromise(input.store.seal(input.config.deviceID, 256, now()))
      if (segment) {
        const path = segmentPath(segment.deviceID, segment.generation)
        const bytes = await encrypt(
          "event",
          input.rootKey,
          segmentContext(segment.deviceID, segment.generation, path),
          segment,
        )
        const existing = await input.provider.stat(path, signal)
        if (existing) {
          const downloaded = await input.provider.download(path, existing.version, signal)
          const committed = await decrypt(
            (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
            "event",
            input.rootKey,
            segmentContext(segment.deviceID, segment.generation, path),
            downloaded.bytes,
          )
          if (JSON.stringify(committed) !== JSON.stringify(segment)) throw new Error("Remote segment conflict")
        } else await input.provider.uploadAtomic(path, bytes, { type: "absent" }, signal)
        await Effect.runPromise(input.store.acknowledge(segment.id))
      }
      const generation = await Effect.runPromise(input.store.head(input.config.deviceID))
      const metadata = await Effect.runPromise(input.metadata())
      const head: Head = {
        version: 1,
        deviceID: input.config.deviceID,
        deviceName: input.config.deviceName ?? String(input.config.deviceID),
        generation,
        acknowledged: input.acknowledged ? await Effect.runPromise(input.acknowledged()) : {},
        metadata,
        revoked: input.revoked ? [...(await Effect.runPromise(input.revoked()))] : [],
      }
      const path = headPath(input.config.deviceID)
      const bytes = await encrypt("metadata", input.rootKey, headContext(input.config.deviceID, path), head)
      const existing = await input.provider.stat(path, signal)
      await input.provider.uploadAtomic(
        path,
        bytes,
        existing ? { type: "version", version: existing.version } : { type: "absent" },
        signal,
      )
      status = { ...status, running: "idle", lastUploadAt: now(), lastError: undefined }
    } catch (cause) {
      status = { ...status, running: "idle", lastError: diagnostic("upload", cause) }
      throw cause
    } finally {
      await Effect.runPromise(input.store.release("upload", owner)).catch(() => undefined)
    }
  }

  const pullOnce = async (signal?: AbortSignal) => {
    if (!status.enabled) return
    const acquired = await Effect.runPromise(input.store.acquire("pull", owner, 60_000, now()))
    if (!acquired) return
    status = { ...status, running: "pull" }
    try {
      const objects = await SyncProvider.listAll(input.provider, "devices", signal)
      const heads: Head[] = []
      for (const object of objects.filter((item) => item.path.endsWith(".head.enc"))) {
        const deviceID = deviceFromHeadPath(object.path)
        if (deviceID === input.config.deviceID) continue
        const downloaded = await input.provider.download(object.path, object.version, signal)
        heads.push(
          await decrypt(
            (value) => Schema.decodeUnknownSync(Head)(value),
            "metadata",
            input.rootKey,
            headContext(deviceID, object.path),
            downloaded.bytes,
          ),
        )
      }
      const revoked = new Set(heads.flatMap((head) => head.revoked))
      indexedHeads = heads
        .filter((head) => !revoked.has(head.deviceID))
        .sort((a, b) => String(a.deviceID).localeCompare(String(b.deviceID)))
      for (const head of indexedHeads) {
        if (revoked.has(head.deviceID)) continue
        if (input.deviceProjector) await Effect.runPromise(input.deviceProjector(head))
        await Effect.runPromise(input.metadataProjector.apply(head.metadata, head.deviceID))
      }
      status = { ...status, running: "idle", lastPullAt: now(), lastError: undefined }
    } catch (cause) {
      status = { ...status, running: "idle", lastError: diagnostic("pull", cause) }
      throw cause
    } finally {
      await Effect.runPromise(input.store.release("pull", owner)).catch(() => undefined)
    }
  }

  const hydrateOnce = async (signal?: AbortSignal) => {
    if (!status.enabled) return
    // Metadata indexing is intentionally a separate committed phase. Opening a
    // metadata-only Session calls hydrate(); idle background work may do so too.
    if (!indexedHeads.length) await coalesce("pull", signal)
    const acquired = await Effect.runPromise(input.store.acquire("hydrate", owner, 60_000, now()))
    if (!acquired) return
    try {
      for (const head of indexedHeads) {
        let cursor = await Effect.runPromise(input.store.cursor(head.deviceID))
        while (cursor < head.generation) {
          signal?.throwIfAborted()
          const generation = cursor + 1
          const path = segmentPath(head.deviceID, generation)
          const object = await input.provider.stat(path, signal)
          if (!object) throw new Error("Remote sync segment is missing")
          const downloaded = await input.provider.download(path, object.version, signal)
          const segment = await decrypt(
            (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
            "event",
            input.rootKey,
            segmentContext(head.deviceID, generation, path),
            downloaded.bytes,
          )
          await Effect.runPromise(input.store.applyDurable(segment, projector(head.deviceID)))
          cursor = generation
        }
      }
    } catch (cause) {
      status = { ...status, lastError: diagnostic("pull", cause) }
      throw cause
    } finally {
      await Effect.runPromise(input.store.release("hydrate", owner)).catch(() => undefined)
    }
  }

  const coalesce = (direction: "upload" | "pull", signal?: AbortSignal) => {
    if (direction === "upload") return (uploadFlight ??= uploadOnce(signal).finally(() => (uploadFlight = undefined)))
    return (pullFlight ??= pullOnce(signal).finally(() => (pullFlight = undefined)))
  }

  return {
    status: () => status,
    enable: (enabled: boolean) => void (status = { ...status, enabled }),
    upload: (signal?: AbortSignal) => Effect.tryPromise(() => coalesce("upload", signal)),
    pull: (signal?: AbortSignal) => Effect.tryPromise(() => coalesce("pull", signal)),
    hydrate: (signal?: AbortSignal) =>
      Effect.tryPromise(() => (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))),
    now: (signal?: AbortSignal) =>
      Effect.tryPromise(async () => {
        await coalesce("upload", signal)
        await coalesce("pull", signal)
        await (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))
      }),
  }
}

function headPath(deviceID: string) {
  return SyncProvider.objectPath(`devices/${deviceID}.head.enc`)
}

function segmentPath(deviceID: string, generation: number) {
  return SyncProvider.objectPath(`segments/${deviceID}/${generation}-${generation}.enc`)
}

function deviceFromHeadPath(path: string) {
  const match = /^devices\/(.+)\.head\.enc$/.exec(path)
  if (!match?.[1]) throw new Error("Invalid remote sync head path")
  return SyncEvent.DeviceID.make(match[1])
}

function headContext(deviceID: string, path: string): SyncCrypto.ObjectContext {
  return { path, type: "head", deviceID, generation: 0, range: "head", schemaVersion: 1 }
}

function segmentContext(deviceID: string, generation: number, path: string): SyncCrypto.ObjectContext {
  return { path, type: "segment", deviceID, generation, range: `${generation}-${generation}`, schemaVersion: 1 }
}

async function encrypt(
  purpose: "metadata" | "event",
  rootKey: Uint8Array,
  context: SyncCrypto.ObjectContext,
  value: unknown,
) {
  const envelope = await SyncCrypto.encrypt(rootKey, purpose, 1, context, encoder.encode(JSON.stringify(value)))
  return encoder.encode(JSON.stringify(envelope))
}

async function decrypt<A>(
  decode: (value: unknown) => A,
  purpose: "metadata" | "event",
  rootKey: Uint8Array,
  context: SyncCrypto.ObjectContext,
  bytes: Uint8Array,
) {
  const plaintext = await SyncCrypto.decrypt(rootKey, purpose, context, JSON.parse(decoder.decode(bytes)))
  return decode(JSON.parse(decoder.decode(plaintext)))
}

function diagnostic(stage: "upload" | "pull", cause: unknown): Status["lastError"] {
  const provider = cause instanceof SyncProvider.ProviderError ? cause : undefined
  return {
    stage,
    retryable: provider?.retryable ?? false,
    message: provider ? provider.message : "Sync operation failed",
  }
}
