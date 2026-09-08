export * as SyncRuntime from "./runtime"

import { Effect, Schema } from "effect"
import { SyncCrypto } from "./crypto"
import { SyncEvent } from "./event"
import { SyncEventStore } from "./event-store"
import { SyncProvider } from "./provider"
import { NonNegativeInt } from "../schema"
import { SyncCodec } from "./codec"
import { SyncTransfer } from "./transfer"
import { SyncDeletion } from "./deletion"

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
  deletions: Schema.Array(SyncEvent.Tombstone).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  revoked: Schema.Array(SyncEvent.DeviceID),
})
export type Head = typeof Head.Type

export const Diagnostic = Schema.Struct({
  stage: Schema.Literals(["attachment", "segment", "head", "pull", "hydrate", "collect", "catalog", "delete"]),
  operation: Schema.optional(Schema.Literals(["list", "stat", "download", "upload", "delete"])),
  kind: Schema.optional(
    Schema.Literals([
      "unauthenticated",
      "permission",
      "not-found",
      "conflict",
      "rate-limit",
      "network",
      "provider",
      "cancelled",
      "invalid-response",
    ]),
  ),
  retryable: Schema.Boolean,
  outcome: Schema.optional(Schema.Literals(["failed", "unknown"])),
  retryAfter: Schema.optional(NonNegativeInt),
  message: Schema.String,
})
export type Diagnostic = typeof Diagnostic.Type

export type Status = {
  readonly enabled: boolean
  readonly running: "idle" | "upload" | "pull"
  readonly lastUploadAt?: number
  readonly lastPullAt?: number
  readonly lastError?: Diagnostic
}

export interface MetadataProjector {
  readonly apply: (metadata: readonly Metadata[], deviceID: SyncEvent.DeviceID) => Effect.Effect<void, unknown>
  readonly retain?: (sessionIDs: readonly string[]) => Effect.Effect<void, unknown>
}

/**
 * Optional bridge for Session payloads which are stored separately from the
 * encrypted event stream.  Runtime owns ordering: object upload happens
 * before segment commit; GC runs only after every active device acknowledged
 * every observed segment.
 */
export interface AttachmentPipeline {
  readonly externalize: (event: SyncEvent.Envelope) => Promise<SyncEvent.Envelope>
  readonly references: (value: unknown) => ReadonlySet<string>
  readonly collect: (input: {
    readonly liveObjectIDs: ReadonlySet<string>
    readonly allActiveDevicesAcknowledged: boolean
    readonly signal?: AbortSignal
  }) => Promise<unknown>
}

export function make(input: {
  readonly config: { readonly deviceID: SyncEvent.DeviceID; readonly deviceName?: string; readonly enabled: boolean }
  readonly rootKey?: Uint8Array
  readonly codec?: SyncCodec.Interface
  readonly provider: SyncProvider.Adapter
  readonly store: SyncEventStore.Interface
  readonly projector: SyncEvent.DurableProjector | ((deviceID: SyncEvent.DeviceID) => SyncEvent.DurableProjector)
  readonly metadata: () => Effect.Effect<readonly Metadata[], unknown>
  readonly metadataProjector: MetadataProjector
  readonly acknowledged?: () => Effect.Effect<Readonly<Record<string, number>>, unknown>
  readonly revoked?: () => Effect.Effect<readonly SyncEvent.DeviceID[], unknown>
  readonly deviceProjector?: (head: Head) => Effect.Effect<void, unknown>
  readonly attachment?: AttachmentPipeline
  readonly transfer?: SyncTransfer.Observer
  readonly now?: () => number
  readonly owner?: string
}) {
  const now = input.now ?? Date.now
  const codec = input.codec ?? (input.rootKey ? SyncCodec.encrypted(input.rootKey) : undefined)
  if (!codec) throw new Error("SyncRuntime requires a codec or root key")
  const owner = input.owner ?? `${process.pid}:${crypto.randomUUID()}`
  let status: Status = { enabled: input.config.enabled, running: "idle" }
  let uploadFlight: Promise<void> | undefined
  let pullFlight: Promise<void> | undefined
  let hydrateFlight: Promise<void> | undefined
  let indexedHeads: readonly Head[] = []
  let indexedSegments = new Map<string, SyncProvider.ObjectInfo>()
  let revokedDevices = new Set<SyncEvent.DeviceID>()
  let localHead: Head | undefined
  const projectors = new Map<SyncEvent.DeviceID, SyncEvent.DurableProjector>()
  const acquireLease = async (kind: "upload" | "pull" | "hydrate", signal?: AbortSignal) => {
    const deadline = Date.now() + 65_000
    while (!(await Effect.runPromise(input.store.acquire(kind, owner, 60_000, now())))) {
      signal?.throwIfAborted()
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for the ${kind} sync lease`)
      await new Promise<void>((resolve, reject) => {
        const aborted = () => {
          clearTimeout(timer)
          reject(signal?.reason)
        }
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", aborted)
          resolve()
        }, 50)
        signal?.addEventListener("abort", aborted, { once: true })
      })
    }
  }
  const mapConcurrent = async <A, B>(items: readonly A[], limit: number, fn: (item: A) => Promise<B>) => {
    const result: B[] = []
    for (let offset = 0; offset < items.length; offset += limit) {
      result.push(...(await Promise.all(items.slice(offset, offset + limit).map(fn))))
    }
    return result
  }
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
    await acquireLease("upload", signal)
    status = { ...status, running: "upload" }
    let stage: Diagnostic["stage"] = "segment"
    try {
      while (true) {
        signal?.throwIfAborted()
        const renewed = await Effect.runPromise(input.store.renew("upload", owner, 60_000, now()))
        if (!renewed) throw new Error("Sync upload lease expired while draining queued segments")
        const segment = await Effect.runPromise(input.store.seal(input.config.deviceID, 256, now()))
        if (!segment) break
        stage = "attachment"
        const wire = input.attachment ? await externalizeSegment(segment, input.attachment) : segment
        stage = "segment"
        const path = segmentPath(segment.deviceID, segment.generation, codec.suffix)
        const bytes = await encode(codec, "event", segmentContext(segment.deviceID, segment.generation, path), wire)
        const existing = await input.provider.stat(path, signal)
        if (existing) {
          await input.transfer?.start("download", "sessions")
          const downloaded = await input.provider.download(path, existing.version, signal)
          await input.transfer?.complete("download", "sessions", downloaded.bytes.length)
          const committed = await decode(
            (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
            codec,
            "event",
            segmentContext(segment.deviceID, segment.generation, path),
            downloaded.bytes,
          )
          if (JSON.stringify(committed) !== JSON.stringify(wire)) throw new Error("Remote segment conflict")
        } else {
          await input.transfer?.start("upload", "sessions")
          await input.provider.uploadAtomic(path, bytes, { type: "absent" }, signal)
          await input.transfer?.complete("upload", "sessions", bytes.length)
        }
        await Effect.runPromise(input.store.acknowledge(segment.id))
      }
      const generation = await Effect.runPromise(input.store.head(input.config.deviceID))
      const metadata = await Effect.runPromise(input.metadata())
      const pendingDeletions: SyncDeletion.Marker[] = []
      for (const tombstone of await Effect.runPromise(input.store.deletions())) {
        const marker = await deletions.ensure(
          tombstone,
          indexedHeads
            .filter((head) => head.metadata.some((item) => item.sessionID === tombstone.sessionID))
            .map((head) => head.deviceID),
          signal,
        )
        pendingDeletions.push(marker)
      }
      const head: Head = {
        version: 1,
        deviceID: input.config.deviceID,
        deviceName: input.config.deviceName ?? String(input.config.deviceID),
        generation,
        acknowledged: input.acknowledged ? await Effect.runPromise(input.acknowledged()) : {},
        metadata,
        deletions: [],
        revoked: input.revoked ? [...(await Effect.runPromise(input.revoked()))] : [],
      }
      stage = "head"
      const path = headPath(input.config.deviceID, codec.suffix)
      const changed = !localHead || JSON.stringify(localHead) !== JSON.stringify(head)
      const published = changed ? await publishHeadMonotonic(input.provider, codec, head, path, signal) : true
      localHead = head
      // A device releases its cloud reference only after its replacement head,
      // which no longer advertises the Session, is durably visible. An ack
      // written before the head would let a crash resurrect stale metadata.
      if (published) {
        for (const marker of pendingDeletions) {
          await deletions.acknowledge(marker, input.config.deviceID, signal)
        }
      }
      stage = "collect"
      if (pendingDeletions.length) {
        await collectDeletions(signal)
        for (const marker of pendingDeletions)
          await Effect.runPromise(input.store.forgetDeletion(marker.tombstone.sessionID))
      }
      status = { ...status, running: "idle", lastUploadAt: now(), lastError: undefined }
    } catch (cause) {
      status = { ...status, running: "idle", lastError: diagnostic(stage, cause) }
      throw cause
    } finally {
      await Effect.runPromise(input.store.release("upload", owner)).catch(() => undefined)
    }
  }

  const pullOnce = async (signal?: AbortSignal) => {
    if (!status.enabled) return
    await acquireLease("pull", signal)
    status = { ...status, running: "pull" }
    try {
      const [objects, segments] = await Promise.all([
        SyncProvider.listAll(input.provider, "devices", signal),
        SyncProvider.listAll(input.provider, "segments", signal),
      ])
      indexedSegments = new Map(segments.map((item) => [item.path, item]))
      const heads: Head[] = []
      for (const object of objects.filter((item) => item.path.endsWith(`.head${codec.suffix}`))) {
        const deviceID = deviceFromHeadPath(object.path, codec.suffix)
        if (deviceID === input.config.deviceID) continue
        const downloaded = await downloadLatest(input.provider, object, signal)
        heads.push(
          await decode(
            (value) => Schema.decodeUnknownSync(Head)(value),
            codec,
            "metadata",
            headContext(deviceID, object.path),
            downloaded.bytes,
          ),
        )
      }
      const revoked = new Set(heads.flatMap((head) => head.revoked))
      revokedDevices = revoked
      indexedHeads = heads
        .filter((head) => !revoked.has(head.deviceID))
        .sort((a, b) => String(a.deviceID).localeCompare(String(b.deviceID)))
      for (const head of indexedHeads) {
        if (revoked.has(head.deviceID)) continue
        if (input.deviceProjector) await Effect.runPromise(input.deviceProjector(head))
      }
      const markers = await deletions.list(signal)
      await Effect.runPromise(
        input.store.absorbDeletions(
          markers.map((item) => item.tombstone),
          projector(input.config.deviceID),
        ),
      )
      const deleted = new Set(markers.map((item) => item.tombstone.sessionID))
      for (const head of indexedHeads)
        await Effect.runPromise(
          input.metadataProjector.apply(
            head.metadata.filter((item) => !deleted.has(item.sessionID)),
            head.deviceID,
          ),
        )
      if (input.metadataProjector.retain)
        await Effect.runPromise(
          input.metadataProjector.retain(
            indexedHeads
              .flatMap((head) => head.metadata.map((item) => item.sessionID))
              .filter((id) => !deleted.has(id)),
          ),
        )
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
    await acquireLease("hydrate", signal)
    try {
      for (const head of indexedHeads) {
        let cursor = await Effect.runPromise(input.store.cursor(head.deviceID))
        while (cursor < head.generation) {
          signal?.throwIfAborted()
          const end = Math.min(head.generation, cursor + 8)
          const batch = await Promise.all(
            Array.from({ length: end - cursor }, (_, index) => cursor + index + 1).map(async (generation) => {
              try {
                const path = segmentPath(head.deviceID, generation, codec.suffix)
                const object = indexedSegments.get(path) ?? (await input.provider.stat(path, signal))
                if (!object) throw new Error(`remote object is missing`)
                await input.transfer?.start("download", "sessions")
                const downloaded = await input.provider.download(path, object.version, signal)
                await input.transfer?.complete("download", "sessions", downloaded.bytes.length)
                return decode(
                  (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
                  codec,
                  "event",
                  segmentContext(head.deviceID, generation, path),
                  downloaded.bytes,
                )
              } catch (cause) {
                throw new Error(
                  `download/decode device ${head.deviceID} generation ${generation}: ${internalReason(cause)}`,
                  { cause },
                )
              }
            }),
          )
          for (const segment of batch) {
            try {
              await Effect.runPromise(input.store.applyDurable(segment, projector(head.deviceID)))
            } catch (cause) {
              throw new Error(
                `apply device ${head.deviceID} generation ${segment.generation}: ${internalReason(cause)}`,
                { cause },
              )
            }
            cursor = segment.generation
          }
        }
      }
    } catch (cause) {
      status = { ...status, lastError: diagnostic("hydrate", cause) }
      throw cause
    } finally {
      await Effect.runPromise(input.store.release("hydrate", owner)).catch(() => undefined)
    }
  }

  const collectAttachments = async (signal?: AbortSignal) => {
    if (!input.attachment) return
    const generation = await Effect.runPromise(input.store.head(input.config.deviceID))
    const local: Head = localHead ?? {
      version: 1,
      deviceID: input.config.deviceID,
      deviceName: input.config.deviceName ?? String(input.config.deviceID),
      generation,
      acknowledged: input.acknowledged ? await Effect.runPromise(input.acknowledged()) : {},
      metadata: [],
      deletions: await Effect.runPromise(input.store.deletions()),
      revoked: [],
    }
    const active = [local, ...indexedHeads]
    // A device inherently knows its own generation. Every *other* active
    // device must explicitly acknowledge it before a referenced object can be
    // removed. Missing acknowledgement information is intentionally unsafe.
    const allActiveDevicesAcknowledged =
      Boolean(input.acknowledged) &&
      active.every((target) =>
        active.every(
          (observer) =>
            target.generation === 0 ||
            observer.deviceID === target.deviceID ||
            (observer.acknowledged[String(target.deviceID)] ?? -1) >= target.generation,
        ),
      )
    const liveObjectIDs = new Set<string>()
    const segments = await mapConcurrent(
      (await SyncProvider.listAll(input.provider, "segments", signal)).flatMap((object) => {
        const location = segmentFromPath(object.path, codec.suffix)
        if (!location) return []
        return [{ object, location }]
      }),
      8,
      ({ object, location }) =>
        input.provider
          .download(object.path, object.version, signal)
          .then((downloaded) =>
            decode(
              (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
              codec,
              "event",
              segmentContext(location.deviceID, location.generation, object.path),
              downloaded.bytes,
            ),
          ),
    )
    // Global session deletion is monotonic.  First collect tombstones from the
    // complete observed history so an attachment in an old event is not kept
    // alive merely because that event was encountered before its tombstone.
    const deleted = new Set<string>()
    for (const segment of segments)
      for (const operation of segment.operations)
        if (operation.kind === "tombstone") deleted.add(operation.tombstone.sessionID)
    for (const segment of segments) {
      for (const operation of segment.operations) {
        if (operation.kind !== "event" || deleted.has(operation.event.aggregateID)) continue
        for (const objectID of input.attachment.references(operation.event.data)) liveObjectIDs.add(objectID)
      }
    }
    await input.attachment.collect({ liveObjectIDs, allActiveDevicesAcknowledged, signal })
  }

  const deletions = SyncDeletion.make({ provider: input.provider, now })

  const collectDeletions = async (signal?: AbortSignal) => {
    const eligible = (await deletions.scan(signal)).filter((item) =>
      item.marker.requiredDevices.every(
        (deviceID) => item.acknowledged.has(deviceID) || revokedDevices.has(deviceID),
      ),
    )
    if (!eligible.length) return
    const deleted = new Set(eligible.map((item) => item.marker.tombstone.sessionID))
    const affected = new Set(
      (await Effect.runPromise(input.store.segmentsFor([...deleted]))).map(({ deviceID, generation }) =>
        segmentPath(deviceID, generation, codec.suffix),
      ),
    )
    const indexed = (await SyncProvider.listAll(input.provider, "segments", signal)).flatMap((object) => {
      if (!affected.has(object.path)) return []
      const location = segmentFromPath(object.path, codec.suffix)
      return location ? [{ object, location }] : []
    })
    const downloaded = await mapConcurrent(indexed, 8, async ({ object, location }) => ({
      object,
      location,
      segment: await input.provider
        .download(object.path, object.version, signal)
        .then((result) =>
          decode(
            (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
            codec,
            "event",
            segmentContext(location.deviceID, location.generation, object.path),
            result.bytes,
          ),
        ),
    }))
    let deletedHadAttachments = false
    for (const { object, location, segment } of downloaded) {
      if (input.attachment)
        for (const operation of segment.operations)
          if (
            operation.kind === "event" &&
            deleted.has(operation.event.aggregateID) &&
            input.attachment.references(operation.event.data).size
          )
            deletedHadAttachments = true
      const operations = segment.operations.filter((operation) =>
        operation.kind === "tombstone"
          ? !deleted.has(operation.tombstone.sessionID)
          : !deleted.has(operation.event.aggregateID),
      )
      const purged = operations.length === segment.operations.length ? segment : SyncEvent.Segment.make({ ...segment, operations })
      if (purged === segment) continue
      const bytes = await encode(codec, "event", segmentContext(location.deviceID, location.generation, object.path), purged)
      await input.provider.uploadAtomic(object.path, bytes, { type: "version", version: object.version }, signal)
    }
    if (deletedHadAttachments) await collectAttachments(signal)
    await deletions.removeScanned(eligible, signal)
  }

  const coalesce = (direction: "upload" | "pull", signal?: AbortSignal) => {
    if (direction === "upload") return (uploadFlight ??= uploadOnce(signal).finally(() => (uploadFlight = undefined)))
    return (pullFlight ??= pullOnce(signal).finally(() => (pullFlight = undefined)))
  }
  const settle = (run: () => Promise<void>) => run().finally(() => input.transfer?.finish())

  return {
    status: () => status,
    enable: (enabled: boolean) => void (status = { ...status, enabled }),
    upload: (signal?: AbortSignal) =>
      Effect.tryPromise(() =>
        settle(async () => {
          await coalesce("pull", signal)
          await (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))
          await coalesce("upload", signal)
        }),
      ),
    pull: (signal?: AbortSignal) => Effect.tryPromise(() => settle(() => coalesce("pull", signal))),
    hydrate: (signal?: AbortSignal) =>
      Effect.tryPromise(() =>
        settle(() => (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))),
      ),
    now: (signal?: AbortSignal) =>
      Effect.tryPromise(() =>
        settle(async () => {
          await coalesce("pull", signal)
          await (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))
          await coalesce("upload", signal)
        }),
      ),
  }
}

function headPath(deviceID: string, suffix: SyncCodec.Interface["suffix"]) {
  return SyncProvider.objectPath(`devices/${deviceID}.head${suffix}`)
}

function segmentPath(deviceID: string, generation: number, suffix: SyncCodec.Interface["suffix"]) {
  return SyncProvider.objectPath(`segments/${deviceID}/${generation}-${generation}${suffix}`)
}

function segmentFromPath(path: string, suffix: SyncCodec.Interface["suffix"]) {
  const match = new RegExp(`^segments/([^/]+)/(\\d+)-\\d+\\${suffix}$`).exec(path)
  if (!match?.[1] || !match[2]) return
  return { deviceID: SyncEvent.DeviceID.make(match[1]), generation: Number.parseInt(match[2], 10) }
}

function deviceFromHeadPath(path: string, suffix: SyncCodec.Interface["suffix"]) {
  const match = new RegExp(`^devices/(.+)\\.head\\${suffix}$`).exec(path)
  if (!match?.[1]) throw new Error("Invalid remote sync head path")
  return SyncEvent.DeviceID.make(match[1])
}

function headContext(deviceID: string, path: string): SyncCrypto.ObjectContext {
  return { path, type: "head", deviceID, generation: 0, range: "head", schemaVersion: 1 }
}

function segmentContext(deviceID: string, generation: number, path: string): SyncCrypto.ObjectContext {
  return { path, type: "segment", deviceID, generation, range: `${generation}-${generation}`, schemaVersion: 1 }
}

async function encode(
  codec: SyncCodec.Interface,
  purpose: "metadata" | "event",
  context: SyncCrypto.ObjectContext,
  value: unknown,
) {
  return codec.seal(purpose, context, encoder.encode(JSON.stringify(value)))
}

async function externalizeSegment(
  segment: SyncEvent.Segment,
  attachment: AttachmentPipeline,
): Promise<SyncEvent.Segment> {
  const operations = await Promise.all(
    segment.operations.map(async (operation) =>
      operation.kind === "event"
        ? SyncEvent.EventOperation.make({ kind: "event", event: await attachment.externalize(operation.event) })
        : operation,
    ),
  )
  return SyncEvent.Segment.make({ ...segment, operations })
}

async function decode<A>(
  decode: (value: unknown) => A,
  codec: SyncCodec.Interface,
  purpose: "metadata" | "event",
  context: SyncCrypto.ObjectContext,
  bytes: Uint8Array,
) {
  const plaintext = await codec.open(purpose, context, bytes)
  return decode(JSON.parse(decoder.decode(plaintext)))
}

async function downloadLatest(provider: SyncProvider.Adapter, listed: SyncProvider.ObjectInfo, signal?: AbortSignal) {
  let current = listed
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.download(current.path, current.version, signal)
    } catch (cause) {
      if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict" || attempt >= 2) throw cause
      signal?.throwIfAborted()
      const latest = await provider.stat(current.path, signal)
      if (!latest) throw cause
      current = latest
    }
  }
}

async function publishHeadMonotonic(
  provider: SyncProvider.Adapter,
  codec: SyncCodec.Interface,
  head: Head,
  path: string,
  signal?: AbortSignal,
) {
  const context = headContext(head.deviceID, path)
  const bytes = await encode(codec, "metadata", context, head)
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    const existing = await provider.stat(path, signal)
    if (existing) {
      try {
        const downloaded = await provider.download(path, existing.version, signal)
        const remote = await decode((value) => Schema.decodeUnknownSync(Head)(value), codec, "metadata", context, downloaded.bytes)
        if (remote.generation > head.generation) return false
        if (JSON.stringify(remote) === JSON.stringify(head)) return true
      } catch (cause) {
        if (cause instanceof SyncProvider.ProviderError && cause.kind === "conflict") continue
        throw cause
      }
    }
    try {
      await provider.uploadAtomic(
        path,
        bytes,
        existing ? { type: "version", version: existing.version } : { type: "absent" },
        signal,
      )
      return true
    } catch (cause) {
      if (cause instanceof SyncProvider.ProviderError && cause.kind === "conflict") continue
      throw cause
    }
  }
  throw new Error("Remote device head changed repeatedly")
}

export function diagnostic(stage: Diagnostic["stage"], cause: unknown): Diagnostic {
  const provider = cause instanceof SyncProvider.ProviderError ? cause : undefined
  const details = [
    provider?.httpStatus === undefined ? undefined : `HTTP ${provider.httpStatus}`,
    provider?.providerCode === undefined ? undefined : `code ${provider.providerCode}`,
    provider?.requestID ? `request ${provider.requestID}` : undefined,
  ].filter((item): item is string => Boolean(item))
  const internal = provider ? undefined : internalReason(cause)
  return {
    stage,
    operation: provider?.operation,
    kind: provider?.kind,
    retryable: provider?.retryable ?? false,
    outcome: provider?.outcome,
    retryAfter: provider?.retryAfter,
    message:
      provider?.providerID === "baidu"
        ? `Baidu Netdisk ${provider.providerPhase ?? provider.operation} failed: ${providerReason(provider.kind)}${details.length ? ` (${details.join(", ")})` : ""}`
        : `Sync ${stage} failed${provider?.providerPhase ? ` (${provider.providerPhase}${details.length ? `, ${details.join(", ")}` : ""})` : details.length ? ` (${details.join(", ")})` : internal ? `: ${internal}` : ""}`,
  }
}

function internalReason(cause: unknown) {
  const tagged = cause && typeof cause === "object" ? cause : undefined
  const fields = tagged
    ? [
        "_tag" in tagged && typeof tagged._tag === "string" ? tagged._tag : undefined,
        "type" in tagged && typeof tagged.type === "string" ? `type ${tagged.type}` : undefined,
        "expected" in tagged ? `expected ${String(tagged.expected)}` : undefined,
        "received" in tagged ? `received ${String(tagged.received)}` : undefined,
      ].filter((item): item is string => Boolean(item))
    : []
  const message = cause instanceof Error && cause.message ? cause.message : undefined
  const value = [message, ...fields].filter((item): item is string => Boolean(item)).join(" · ") || String(cause)
  return value.replace(/\s+/g, " ").slice(0, 240)
}

function providerReason(kind: SyncProvider.ErrorKind) {
  return {
    unauthenticated: "sign-in required",
    permission: "permission denied",
    "not-found": "remote object not found",
    conflict: "remote object changed",
    "rate-limit": "request rate limited",
    network: "network request failed",
    provider: "provider rejected the request",
    cancelled: "request cancelled",
    "invalid-response": "response did not match the documented schema",
  }[kind]
}
