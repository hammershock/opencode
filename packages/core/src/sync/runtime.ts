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
import { createHash } from "node:crypto"

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

export type HeadFence = {
  readonly generation: number
  readonly digest: string
  readonly sessionIDs: ReadonlySet<string>
  readonly head: Head
}

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
  /** Durable, conservative device membership used to freeze deletion
   * references. It must not be derived only from this process's head cache. */
  readonly requiredDevices?: () => Effect.Effect<readonly SyncEvent.DeviceID[], unknown>
  readonly deviceProjector?: (head: Head) => Effect.Effect<void, unknown>
  /** Protocol v2 carries deletion authority in the append-only control log.
   * The legacy deletion archive remains available only for isolated runtime
   * tests and old protocol readers; it must not rewrite immutable segments on
   * providers without compare-and-swap. */
  readonly deletionMode?: "legacy" | "control-log"
  /** Finalizes local routing after every active device acknowledged a deletion.
   * It runs after payload collection but before the cloud marker is removed, so
   * a crash cannot lose both the durable local route and the recovery marker. */
  readonly deletionCollected?: (sessionIDs: readonly string[]) => Effect.Effect<void, unknown>
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
  let probeFlight: Promise<boolean> | undefined
  let indexedHeads: readonly Head[] = []
  let probedDevices: readonly SyncProvider.ObjectInfo[] | undefined
  let cachedHeads = new Map<string, { readonly version: string; readonly head: Head }>()
  let revokedDevices = new Set<SyncEvent.DeviceID>()
  let localHead: Head | undefined
  let localHeadObject: SyncProvider.ObjectInfo | undefined
  const pendingDeletionIDs = new Set<string>()
  const projectors = new Map<SyncEvent.DeviceID, SyncEvent.DurableProjector>()
  const acquireLease = async (kind: "upload" | "pull" | "hydrate", signal?: AbortSignal) => {
    const deadline = Date.now() + DIRECTION_LEASE_WAIT
    while (!(await Effect.runPromise(input.store.acquire(kind, owner, DIRECTION_LEASE_TTL, now())))) {
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
  const withLease = async <A>(
    kind: "upload" | "pull" | "hydrate",
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<A>,
  ) => {
    await acquireLease(kind, signal)
    const controller = new AbortController()
    const active = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    let renewing = false
    const heartbeat = globalThis.setInterval(() => {
      if (renewing || controller.signal.aborted) return
      renewing = true
      void Effect.runPromise(input.store.renew(kind, owner, DIRECTION_LEASE_TTL, now()))
        .then((held) => {
          if (!held) controller.abort(new Error(`Sync ${kind} lease was lost`))
        })
        .catch((cause) => controller.abort(cause))
        .finally(() => void (renewing = false))
    }, DIRECTION_LEASE_HEARTBEAT)
    try {
      const held = await Effect.runPromise(input.store.renew(kind, owner, DIRECTION_LEASE_TTL, now()))
      if (!held) throw new Error(`Sync ${kind} lease was lost before work started`)
      return await run(active)
    } finally {
      globalThis.clearInterval(heartbeat)
      await Effect.runPromise(input.store.release(kind, owner)).catch(() => undefined)
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

  const discoverHeadObjects = async (signal?: AbortSignal) => {
    if (!input.requiredDevices) return SyncProvider.listAll(input.provider, "devices", signal)
    const members = await Effect.runPromise(input.requiredDevices())
    const active = members.filter((deviceID) => deviceID !== input.config.deviceID && !revokedDevices.has(deviceID))
    const paths = active.map((deviceID) => headPath(deviceID, codec.suffix))
    const objects = input.provider.statMany
      ? await input.provider.statMany(paths, signal)
      : await mapConcurrent(paths, 8, (path) => input.provider.stat(path, signal))
    return objects.filter((object): object is SyncProvider.ObjectInfo => Boolean(object))
  }

  const desiredHead = async (generation: number): Promise<Head> =>
    normalizeHead({
      version: 1,
      deviceID: input.config.deviceID,
      deviceName: input.config.deviceName ?? String(input.config.deviceID),
      generation,
      acknowledged: input.acknowledged ? await Effect.runPromise(input.acknowledged()) : {},
      metadata: await Effect.runPromise(input.metadata()),
      deletions: [],
      revoked: input.revoked ? [...(await Effect.runPromise(input.revoked()))] : [],
    })

  const publishLocalHead = async (head: Head, signal?: AbortSignal, assertLease?: () => Promise<void>) => {
    const path = headPath(input.config.deviceID, codec.suffix)
    const result =
      localHead && headDominates(localHead, head)
        ? { published: true, object: localHeadObject, head: localHead }
        : await publishHeadMonotonic(
            input.provider,
            codec,
            head,
            path,
            localHead && localHeadObject ? { head: localHead, object: localHeadObject } : undefined,
            signal,
            assertLease,
          )
    localHead = result.head
    localHeadObject = result.object
    return result.published
  }

  const uploadOnce = async (reconcileDeletions: boolean, signal?: AbortSignal) => {
    if (!status.enabled) return
    await withLease("upload", signal, async (leaseSignal) => {
      status = { ...status, running: "upload" }
      let stage: Diagnostic["stage"] = "segment"
      const assertUploadLease = async () => {
        const active = await Effect.runPromise(input.store.renew("upload", owner, DIRECTION_LEASE_TTL, now()))
        if (!active) throw new Error("Sync upload lease expired before committing a mutable head")
      }
      const pendingDeletions = new Map<string, SyncDeletion.Marker>()
      let publishedSegments = 0
      const ensureDeletions = async (tombstones: readonly SyncEvent.Tombstone[]) => {
        if (input.deletionMode === "control-log") return
        if (!tombstones.length) return
        const required = new Set<SyncEvent.DeviceID>([
          input.config.deviceID,
          ...indexedHeads.map((head) => head.deviceID),
          ...(input.requiredDevices ? await Effect.runPromise(input.requiredDevices()) : []),
        ])
        for (const deviceID of revokedDevices) required.delete(deviceID)
        for (const tombstone of tombstones) {
          const marker = await deletions.ensure(tombstone, [...required], leaseSignal)
          pendingDeletions.set(marker.tombstone.sessionID, marker)
        }
      }
      try {
        while (true) {
          leaseSignal.throwIfAborted()
          const renewed = await Effect.runPromise(input.store.renew("upload", owner, DIRECTION_LEASE_TTL, now()))
          if (!renewed) throw new Error("Sync upload lease expired while draining queued segments")
          const segment = await Effect.runPromise(input.store.seal(input.config.deviceID, 256, now()))
          if (!segment) break
          await ensureDeletions(
            segment.operations.flatMap((operation) => (operation.kind === "tombstone" ? [operation.tombstone] : [])),
          )
          stage = "attachment"
          const wire = input.attachment ? await externalizeSegment(segment, input.attachment) : segment
          stage = "segment"
          const path = segmentPath(segment.deviceID, segment.generation, codec.suffix)
          const bytes = await encode(codec, "event", segmentContext(segment.deviceID, segment.generation, path), wire)
          try {
            await input.transfer?.start("upload", "sessions")
            await input.provider.uploadAtomic(path, bytes, { type: "absent" }, leaseSignal)
            await input.transfer?.complete("upload", "sessions", bytes.length)
          } catch (cause) {
            if (
              !(cause instanceof SyncProvider.ProviderError) ||
              (cause.kind !== "conflict" && cause.outcome !== "unknown")
            )
              throw cause
            // Immutable generations normally do not exist. Probe only after
            // create reports a conflict/unknown outcome, then accept the exact
            // already-committed payload as crash recovery.
            const existing = await input.provider.stat(path, leaseSignal)
            if (!existing) throw cause
            await input.transfer?.start("download", "sessions")
            const downloaded = await input.provider.download(path, existing.version, leaseSignal)
            await input.transfer?.complete("download", "sessions", downloaded.bytes.length)
            const committed = await decode(
              (value) => Schema.decodeUnknownSync(SyncEvent.Segment)(value),
              codec,
              "event",
              segmentContext(segment.deviceID, segment.generation, path),
              downloaded.bytes,
            )
            if (JSON.stringify(committed) !== JSON.stringify(wire)) throw new Error("Remote segment conflict")
          }
          stage = "head"
          await assertUploadLease()
          const published = await publishLocalHead(
            await desiredHead(segment.generation),
            leaseSignal,
            assertUploadLease,
          )
          await assertUploadLease()
          if (!published) throw new Error("Remote device head is ahead of the pending local segment")
          leaseSignal.throwIfAborted()
          // Clearing the durable outbox is the commit point. Both the discovery
          // head and any deletion acknowledgement must be visible first, so a
          // crash leaves this segment available for deterministic retry.
          if (input.deletionMode !== "control-log")
            for (const marker of pendingDeletions.values()) {
              await deletions.acknowledge(marker, input.config.deviceID, leaseSignal)
              pendingDeletionIDs.delete(marker.tombstone.sessionID)
            }
          await Effect.runPromise(input.store.acknowledge(segment.id))
          publishedSegments++
          // Automatic push is deliberately a burst, not an unbounded drain.
          // This lets an overdue inbound probe run even while local events keep
          // arriving continuously. Explicit/full sync still drains everything.
          if (!reconcileDeletions && publishedSegments >= PUSH_SEGMENT_BUDGET) break
        }
        const localDeletions = new Set(
          (await Effect.runPromise(input.store.deletions())).map((tombstone) => tombstone.sessionID),
        )
        const discovered =
          input.deletionMode === "control-log"
            ? []
            : reconcileDeletions
              ? await deletions.list(leaseSignal)
              : (
                  await Promise.all([...pendingDeletionIDs].map((sessionID) => deletions.read(sessionID, leaseSignal)))
                ).filter((marker): marker is SyncDeletion.Marker => Boolean(marker))
        for (const marker of discovered)
          if (localDeletions.has(marker.tombstone.sessionID)) pendingDeletions.set(marker.tombstone.sessionID, marker)
        const generation = await Effect.runPromise(input.store.head(input.config.deviceID))
        stage = "head"
        await assertUploadLease()
        const published = await publishLocalHead(await desiredHead(generation), leaseSignal, assertUploadLease)
        await assertUploadLease()
        // A stale process with no pending segment must not regress a newer head.
        // It also must not acknowledge deletions against state it did not publish.
        if (!published) {
          status = { ...status, running: "idle", lastUploadAt: now(), lastError: undefined }
          return
        }
        leaseSignal.throwIfAborted()
        // A device releases its cloud reference only after its replacement head,
        // which no longer advertises the Session, is durably visible. An ack
        // written before the head would let a crash resurrect stale metadata.
        if (input.deletionMode !== "control-log")
          for (const marker of pendingDeletions.values()) {
            await deletions.acknowledge(marker, input.config.deviceID, leaseSignal)
            pendingDeletionIDs.delete(marker.tombstone.sessionID)
          }
        stage = "collect"
        if (input.deletionMode !== "control-log" && pendingDeletions.size) {
          await collectDeletions(leaseSignal)
          // Keep the compact local tombstone after cloud payload collection. It
          // is the durable remove-wins fact that rejects stale local history,
          // while the cloud marker and acknowledgements may be fully reclaimed.
        }
        status = { ...status, running: "idle", lastUploadAt: now(), lastError: undefined }
      } catch (cause) {
        status = { ...status, running: "idle", lastError: diagnostic(stage, cause) }
        throw cause
      }
    })
  }

  const pullOnce = async (reconcileDeletions: boolean, signal?: AbortSignal) => {
    if (!status.enabled) return
    await withLease("pull", signal, async (leaseSignal) => {
      status = { ...status, running: "pull" }
      try {
        const indexed = probedDevices
        probedDevices = undefined
        const [objects, markers] = await Promise.all([
          indexed ? Promise.resolve(indexed) : discoverHeadObjects(leaseSignal),
          reconcileDeletions && input.deletionMode !== "control-log"
            ? deletions.list(leaseSignal)
            : Promise.resolve([]),
        ])
        const remoteHeads = objects.flatMap((object) => {
          if (!object.path.endsWith(`.head${codec.suffix}`)) return []
          const deviceID = deviceFromHeadPath(object.path, codec.suffix)
          return deviceID === input.config.deviceID ? [] : [{ object, deviceID }]
        })
        const visible = new Set(remoteHeads.map(({ deviceID }) => String(deviceID)))
        const nextCache = new Map(cachedHeads)
        let unresolvedHead = false
        const heads = await mapConcurrent(remoteHeads, 8, async ({ object, deviceID }) => {
          const cached = cachedHeads.get(String(deviceID))
          if (cached?.version === object.version) return cached.head
          const downloaded = await downloadLatest(input.provider, object, leaseSignal)
          // Mutable heads are replaced atomically. Some providers can expose the
          // directory entry before its replacement is downloadable. Preserve an
          // older decoded head (or omit a first-seen one) for this pull so one
          // temporarily invisible device cannot fail every other device. The
          // cache deliberately keeps the old object version, making the next
          // lightweight probe observe the mismatch and retry.
          if (!downloaded) {
            unresolvedHead = true
            return cached?.head
          }
          const head = await decode(
            (value) => Schema.decodeUnknownSync(Head)(value),
            codec,
            "metadata",
            headContext(deviceID, object.path),
            downloaded.bytes,
          )
          nextCache.set(String(deviceID), { version: downloaded.version, head })
          return head
        })
        // A provider directory listing is a discovery hint, not a deletion log.
        // Keep a previously committed head when one listing omits it; explicit
        // revocation and tombstones are the only monotonic removal facts.
        const availableHeads = [
          ...heads.filter((head): head is Head => Boolean(head)),
          ...[...cachedHeads].filter(([deviceID]) => !visible.has(deviceID)).map(([, cached]) => cached.head),
        ]
        const revoked = new Set([...revokedDevices, ...availableHeads.flatMap((head) => head.revoked)])
        const nextHeads = availableHeads
          .filter((head) => !revoked.has(head.deviceID))
          .sort((a, b) => String(a.deviceID).localeCompare(String(b.deviceID)))
        for (const head of nextHeads) {
          leaseSignal.throwIfAborted()
          if (revoked.has(head.deviceID)) continue
          if (input.deviceProjector) await Effect.runPromise(input.deviceProjector(head))
        }
        await Effect.runPromise(
          input.store.absorbDeletions(
            markers.map((item) => item.tombstone),
            projector(input.config.deviceID),
          ),
        )
        const deleted = new Set(markers.map((item) => item.tombstone.sessionID))
        for (const head of nextHeads)
          await Effect.runPromise(
            input.metadataProjector.apply(
              head.metadata.filter((item) => !deleted.has(item.sessionID)),
              head.deviceID,
            ),
          )
        // Metadata rows are a projection of every active remote device head, not
        // an independent deletion source. Prune them only after a complete,
        // successfully decoded membership snapshot. A cached head covers a
        // transient directory omission; a known device with no head, or a newly
        // listed head that is not readable yet, makes the snapshot incomplete.
        if (input.metadataProjector.retain && !unresolvedHead) {
          const required = input.requiredDevices
            ? await Effect.runPromise(input.requiredDevices())
            : nextHeads.map((head) => head.deviceID)
          const represented = new Set(nextHeads.map((head) => String(head.deviceID)))
          const complete = required.every(
            (deviceID) =>
              deviceID === input.config.deviceID || revoked.has(deviceID) || represented.has(String(deviceID)),
          )
          if (complete) {
            const live = [
              ...new Set(
                nextHeads.flatMap((head) =>
                  head.metadata.filter((item) => !deleted.has(item.sessionID)).map((item) => item.sessionID),
                ),
              ),
            ]
            leaseSignal.throwIfAborted()
            await Effect.runPromise(input.metadataProjector.retain(live))
          }
        }
        // Commit the in-memory discovery snapshot only after every projection
        // step succeeds. A partial pull must remain visible to the next probe.
        cachedHeads = nextCache
        indexedHeads = nextHeads
        revokedDevices = revoked
        status = { ...status, running: "idle", lastPullAt: now(), lastError: undefined }
      } catch (cause) {
        status = { ...status, running: "idle", lastError: diagnostic("pull", cause) }
        throw cause
      }
    })
  }

  const probeOnce = async (signal?: AbortSignal) => {
    if (!status.enabled) return false
    try {
      const objects = await discoverHeadObjects(signal)
      const remote = new Map(
        objects.flatMap((object) => {
          if (!object.path.endsWith(`.head${codec.suffix}`)) return []
          const deviceID = deviceFromHeadPath(object.path, codec.suffix)
          return deviceID === input.config.deviceID ? [] : [[String(deviceID), object.version] as const]
        }),
      )
      const changed =
        remote.size !== cachedHeads.size ||
        [...remote].some(([deviceID, version]) => cachedHeads.get(deviceID)?.version !== version)
      const behind = (
        await Promise.all(
          [...cachedHeads.values()].map(async ({ head }) =>
            revokedDevices.has(head.deviceID)
              ? false
              : (await Effect.runPromise(input.store.cursor(head.deviceID))) < head.generation,
          ),
        )
      ).some(Boolean)
      // A following pull consumes this exact listing instead of paying for the
      // same metadata request twice on Baidu Netdisk.
      if (changed || behind) probedDevices = objects
      return changed || behind
    } catch (cause) {
      status = { ...status, lastError: diagnostic("pull", cause) }
      throw cause
    }
  }

  const hydrateOnce = async (signal?: AbortSignal) => {
    if (!status.enabled) return
    // Metadata indexing is intentionally a separate committed phase. Opening a
    // metadata-only Session calls hydrate(); idle background work may do so too.
    if (!indexedHeads.length) await coalescePull(true, signal)
    await withLease("hydrate", signal, async (leaseSignal) => {
      try {
        for (const head of indexedHeads) {
          let cursor = await Effect.runPromise(input.store.cursor(head.deviceID))
          while (cursor < head.generation) {
            leaseSignal.throwIfAborted()
            const end = Math.min(head.generation, cursor + 8)
            const batch = await Promise.all(
              Array.from({ length: end - cursor }, (_, index) => cursor + index + 1).map(async (generation) => {
                try {
                  const path = segmentPath(head.deviceID, generation, codec.suffix)
                  await input.transfer?.start("download", "sessions")
                  // Segment paths are deterministic and immutable. Exact-path
                  // download avoids a directory-list round trip and cannot be
                  // confused by Baidu's eventually consistent list results.
                  const downloaded = await input.provider.download(path, undefined, leaseSignal)
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
              leaseSignal.throwIfAborted()
              try {
                await Effect.runPromise(input.store.applyDurable(segment, projector(head.deviceID)))
              } catch (cause) {
                throw new Error(
                  `apply device ${head.deviceID} generation ${segment.generation}: ${internalReason(cause)}`,
                  { cause },
                )
              }
              if (input.deletionMode !== "control-log")
                for (const operation of segment.operations)
                  if (operation.kind === "tombstone") pendingDeletionIDs.add(operation.tombstone.sessionID)
              cursor = segment.generation
            }
          }
        }
      } catch (cause) {
        status = { ...status, lastError: diagnostic("hydrate", cause) }
        throw cause
      }
    })
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
      item.marker.requiredDevices.every((deviceID) => item.acknowledged.has(deviceID) || revokedDevices.has(deviceID)),
    )
    if (!eligible.length) return []
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
      const purged =
        operations.length === segment.operations.length ? segment : SyncEvent.Segment.make({ ...segment, operations })
      if (purged === segment) continue
      const bytes = await encode(
        codec,
        "event",
        segmentContext(location.deviceID, location.generation, object.path),
        purged,
      )
      await input.provider.uploadAtomic(object.path, bytes, { type: "version", version: object.version }, signal)
    }
    if (deletedHadAttachments) await collectAttachments(signal)
    const collected = eligible.map((item) => item.marker.tombstone.sessionID)
    await Effect.runPromise(input.deletionCollected?.(collected) ?? Effect.void)
    await deletions.removeScanned(eligible, signal)
    return collected
  }

  let uploadReconcilesDeletions = false
  const coalesceUpload = (reconcileDeletions: boolean, signal?: AbortSignal): Promise<void> => {
    if (uploadFlight) {
      const satisfies = uploadReconcilesDeletions || !reconcileDeletions
      return satisfies ? uploadFlight : uploadFlight.then(() => coalesceUpload(true, signal))
    }
    uploadReconcilesDeletions = reconcileDeletions
    const flight = uploadOnce(reconcileDeletions, signal).finally(() => {
      if (uploadFlight !== flight) return
      uploadFlight = undefined
      uploadReconcilesDeletions = false
    })
    uploadFlight = flight
    return flight
  }
  let pullReconcilesDeletions = false
  const coalescePull = (reconcileDeletions: boolean, signal?: AbortSignal): Promise<void> => {
    if (pullFlight) {
      const satisfies = pullReconcilesDeletions || !reconcileDeletions
      return satisfies ? pullFlight : pullFlight.then(() => coalescePull(true, signal))
    }
    pullReconcilesDeletions = reconcileDeletions
    const flight = pullOnce(reconcileDeletions, signal).finally(() => {
      if (pullFlight !== flight) return
      pullFlight = undefined
      pullReconcilesDeletions = false
    })
    pullFlight = flight
    return flight
  }
  const settle = (run: () => Promise<void>) => run().finally(() => input.transfer?.finish())
  const headPending = async () => {
    if (!status.enabled) return false
    if (pendingDeletionIDs.size) return true
    if (!localHead) return true
    const generation = await Effect.runPromise(input.store.head(input.config.deviceID))
    if (localHead.generation < generation) return true
    if ((input.config.deviceName ?? String(input.config.deviceID)) !== localHead.deviceName) return true
    if (input.acknowledged) {
      const acknowledged = await Effect.runPromise(input.acknowledged())
      if (Object.entries(acknowledged).some(([deviceID, cursor]) => (localHead?.acknowledged[deviceID] ?? -1) < cursor))
        return true
    }
    if (input.revoked) {
      const revoked = await Effect.runPromise(input.revoked())
      if (revoked.some((deviceID) => !localHead?.revoked.includes(deviceID))) return true
    }
    // Session metadata changes are paired with a durable event/tombstone and
    // are detected by store.dirty() in the coordinator. This hot-path check is
    // intentionally limited to the small monotonic fields so an idle one-second
    // scheduler tick never scans every Session row.
    return false
  }
  const headFence = (): HeadFence | undefined => {
    if (!localHead || !localHeadObject) return undefined
    const normalized = normalizeHead(localHead)
    return {
      generation: normalized.generation,
      digest: createHash("sha256").update(canonicalJSON(normalized)).digest("hex"),
      sessionIDs: new Set(normalized.metadata.map((item) => item.sessionID)),
      head: normalized,
    }
  }

  return {
    status: () => status,
    enable: (enabled: boolean) => void (status = { ...status, enabled }),
    upload: (signal?: AbortSignal) =>
      Effect.tryPromise(() =>
        settle(async () => {
          await coalescePull(true, signal)
          await (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))
          await coalesceUpload(true, signal)
        }),
      ),
    /** Pushes already-captured local operations without paying for a remote
     * reconciliation first. The immutable segment is committed before the
     * mutable device head, so receivers never observe an incomplete update. */
    push: (signal?: AbortSignal) => Effect.tryPromise(() => settle(() => coalesceUpload(false, signal))),
    pull: (signal?: AbortSignal) => Effect.tryPromise(() => settle(() => coalescePull(true, signal))),
    /** Receives active device deltas without scanning the durable deletion
     * archive. Tombstones still arrive in their originating event segments;
     * the archive is reconciled by explicit/full sync. */
    receive: (signal?: AbortSignal) => Effect.tryPromise(() => settle(() => coalescePull(false, signal))),
    probe: (signal?: AbortSignal) =>
      Effect.tryPromise(() => (probeFlight ??= probeOnce(signal).finally(() => (probeFlight = undefined)))),
    /** Head-only changes such as remote acknowledgements must be published even
     * when the local event outbox is empty. */
    headPending: () => Effect.tryPromise(headPending),
    /** Returns a proof only after the corresponding head replacement was
     * uploaded and verified. The control log records this immutable digest;
     * callers additionally use the local Session set to ensure the deleted
     * aggregate is absent before acknowledging its deletion. */
    headFence,
    hydrate: (signal?: AbortSignal) =>
      Effect.tryPromise(() =>
        settle(() => (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))),
      ),
    now: (signal?: AbortSignal) =>
      Effect.tryPromise(() =>
        settle(async () => {
          await coalescePull(true, signal)
          await (hydrateFlight ??= hydrateOnce(signal).finally(() => (hydrateFlight = undefined)))
          await coalesceUpload(true, signal)
        }),
      ),
  }
}

function headPath(deviceID: string, suffix: SyncCodec.Interface["suffix"]) {
  return SyncProvider.objectPath(`devices/${deviceID}.head${suffix}`)
}

const PUSH_SEGMENT_BUDGET = 4
const DIRECTION_LEASE_TTL = 8_000
const DIRECTION_LEASE_HEARTBEAT = 2_000
const DIRECTION_LEASE_WAIT = 12_000

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
      if (!(cause instanceof SyncProvider.ProviderError)) throw cause
      if (cause.kind === "not-found") {
        signal?.throwIfAborted()
        if (attempt >= 2) return
        try {
          return await provider.download(current.path, undefined, signal)
        } catch (latestCause) {
          if (!(latestCause instanceof SyncProvider.ProviderError)) throw latestCause
          if (latestCause.kind === "not-found") return
          if (latestCause.kind !== "conflict") throw latestCause
        }
      }
      if (cause.kind !== "conflict" && cause.kind !== "not-found") throw cause
      if (attempt >= 2) throw cause
      signal?.throwIfAborted()
      const latest = await provider.stat(current.path, signal)
      if (!latest) return
      current = latest
    }
  }
}

async function publishHeadMonotonic(
  provider: SyncProvider.Adapter,
  codec: SyncCodec.Interface,
  head: Head,
  path: string,
  cached?: { readonly head: Head; readonly object: SyncProvider.ObjectInfo },
  signal?: AbortSignal,
  assertLease?: () => Promise<void>,
) {
  const context = headContext(head.deviceID, path)
  let candidate = head
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted()
    if (cached) {
      const merged = mergeHead(cached.head, candidate)
      if (!merged) return { published: false, object: cached.object, head: cached.head }
      candidate = merged
      if (JSON.stringify(cached.head) === JSON.stringify(candidate))
        return { published: true, object: cached.object, head: cached.head }
      try {
        const bytes = await encode(codec, "metadata", context, candidate)
        await assertLease?.()
        const object = await provider.uploadAtomic(
          path,
          bytes,
          { type: "version", version: cached.object.version },
          signal,
        )
        await assertLease?.()
        return { published: true, object, head: candidate }
      } catch (cause) {
        if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict") throw cause
        cached = undefined
      }
    }
    const existing = await provider.stat(path, signal)
    if (existing) {
      try {
        const downloaded = await provider.download(path, existing.version, signal)
        const remote = await decode(
          (value) => Schema.decodeUnknownSync(Head)(value),
          codec,
          "metadata",
          context,
          downloaded.bytes,
        )
        const merged = mergeHead(remote, candidate)
        if (!merged) return { published: false, object: existing, head: remote }
        candidate = merged
        if (JSON.stringify(remote) === JSON.stringify(candidate))
          return { published: true, object: existing, head: remote }
      } catch (cause) {
        if (
          cause instanceof SyncProvider.ProviderError &&
          (cause.kind === "conflict" || (cause.kind === "not-found" && cause.retryable)) &&
          attempt < 2
        )
          continue
        throw cause
      }
    }
    try {
      const bytes = await encode(codec, "metadata", context, candidate)
      await assertLease?.()
      const object = await provider.uploadAtomic(
        path,
        bytes,
        existing ? { type: "version", version: existing.version } : { type: "absent" },
        signal,
      )
      await assertLease?.()
      return { published: true, object, head: candidate }
    } catch (cause) {
      if (cause instanceof SyncProvider.ProviderError && cause.kind === "conflict") continue
      throw cause
    }
  }
  throw new Error("Remote device head changed repeatedly")
}

/** Same-device head fields that represent observed facts may only grow. The
 * metadata snapshot intentionally remains the caller's desired state so a
 * Session deletion can remove an entry. */
function mergeHead(remote: Head, desired: Head): Head | undefined {
  if (remote.deviceID !== desired.deviceID) throw new Error("Remote device head identity does not match its path")
  if (remote.generation > desired.generation) return
  const acknowledged = { ...remote.acknowledged }
  for (const [deviceID, generation] of Object.entries(desired.acknowledged))
    acknowledged[deviceID] = Math.max(acknowledged[deviceID] ?? 0, generation)
  return normalizeHead({
    ...desired,
    acknowledged,
    revoked: [...new Set([...remote.revoked, ...desired.revoked])],
  })
}

function normalizeHead(head: Head): Head {
  return {
    ...head,
    acknowledged: Object.fromEntries(
      Object.entries(head.acknowledged).toSorted(([left], [right]) => left.localeCompare(right)),
    ),
    metadata: head.metadata.toSorted((left, right) => left.sessionID.localeCompare(right.sessionID)),
    deletions: head.deletions.toSorted(
      (left, right) => left.sessionID.localeCompare(right.sessionID) || left.id.localeCompare(right.id),
    ),
    revoked: [...new Set(head.revoked)].toSorted((left, right) => String(left).localeCompare(String(right))),
  }
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("Head values must be JSON serializable")
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJSON(item)}`)
    .join(",")}}`
}

function headDominates(published: Head, desired: Head) {
  if (published.deviceID !== desired.deviceID || published.generation < desired.generation) return false
  if (published.generation > desired.generation) return true
  const normalizedPublished = normalizeHead(published)
  const normalizedDesired = normalizeHead(desired)
  if (normalizedPublished.deviceName !== normalizedDesired.deviceName) return false
  if (JSON.stringify(normalizedPublished.metadata) !== JSON.stringify(normalizedDesired.metadata)) return false
  if (JSON.stringify(normalizedPublished.deletions) !== JSON.stringify(normalizedDesired.deletions)) return false
  if (normalizedDesired.revoked.some((deviceID) => !normalizedPublished.revoked.includes(deviceID))) return false
  return Object.entries(normalizedDesired.acknowledged).every(
    ([deviceID, generation]) => (normalizedPublished.acknowledged[deviceID] ?? -1) >= generation,
  )
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
