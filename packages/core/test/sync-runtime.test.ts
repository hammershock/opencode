import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRuntime } from "@opencode-ai/core/sync/runtime"
import { SyncCodec } from "@opencode-ai/core/sync/codec"
import { SyncAttachment } from "@opencode-ai/core/sync/attachment"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { SyncTransfer } from "@opencode-ai/core/sync/transfer"
import type { SyncTransferEvent } from "@opencode-ai/schema/sync-transfer-event"

function provider() {
  const files = new Map<string, { bytes: Uint8Array; version: number }>()
  const counts = { list: 0, stat: 0, download: 0, upload: 0, delete: 0 }
  const adapter: SyncProvider.Adapter = {
    id: "memory",
    list: async (prefix) => {
      counts.list++
      return {
        objects: [...files]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, value]) => ({ path, version: String(value.version), size: value.bytes.length })),
      }
    },
    stat: async (path) => {
      counts.stat++
      const value = files.get(path)
      return value && { path, version: String(value.version), size: value.bytes.length }
    },
    download: async (path, version) => {
      counts.download++
      const value = files.get(path)
      if (!value || (version && version !== String(value.version))) throw new Error("missing")
      return { path, version: String(value.version), size: value.bytes.length, bytes: value.bytes }
    },
    uploadAtomic: async (path, bytes, precondition) => {
      counts.upload++
      const current = files.get(path)
      if (precondition.type === "absent" && current)
        throw new SyncProvider.ProviderError("memory", "upload", "conflict", false)
      if (precondition.type === "version" && String(current?.version) !== precondition.version)
        throw new SyncProvider.ProviderError("memory", "upload", "conflict", false)
      const value = { bytes: bytes.slice(), version: (current?.version ?? 0) + 1 }
      files.set(path, value)
      return { path, version: String(value.version), size: bytes.length }
    },
    deleteBatch: async (objects) => {
      counts.delete++
      return objects.map((object) => {
        const current = files.get(object.path)
        if (!current) return { path: object.path, status: "missing" as const }
        if (String(current.version) !== object.version)
          return { path: object.path, status: "conflict" as const, version: String(current.version) }
        files.delete(object.path)
        return { path: object.path, status: "deleted" as const }
      })
    },
  }
  return { adapter, files, counts }
}

function store(deviceID: SyncEvent.DeviceID, event?: SyncEvent.Envelope, operations?: readonly SyncEvent.Operation[]) {
  let local = event
  let pendingOperations = operations
  let sealed: SyncEvent.Segment | undefined
  let acknowledgedHead = 0
  const cursors = new Map<string, number>()
  const applied: SyncEvent.Envelope[] = []
  const knownSegments: SyncEvent.Segment[] = []
  const deletions = (operations ?? [])
    .filter((operation): operation is typeof operation & { kind: "tombstone" } => operation.kind === "tombstone")
    .map((operation) => operation.tombstone)
  const service = {
    enqueue: () => Effect.void,
    delete: () => Effect.void,
    pending: () => Effect.succeed(local ? [local] : []),
    seal: (_deviceID: SyncEvent.DeviceID) =>
      Effect.sync(() => {
        if (sealed) return sealed
        if (!local && !pendingOperations) return undefined
        sealed = SyncEvent.Segment.make({
          version: 1,
          id: SyncEvent.SegmentID.make(`${deviceID}:1`),
          deviceID,
          generation: 1,
          createdAt: 1,
          operations: pendingOperations ?? [{ kind: "event", event: local! }],
        })
        knownSegments.push(sealed)
        return sealed
      }),
    acknowledge: () =>
      Effect.sync(() => {
        acknowledgedHead = sealed?.generation ?? acknowledgedHead
        local = undefined
        pendingOperations = undefined
        sealed = undefined
      }),
    head: () => Effect.succeed(sealed?.generation ?? acknowledgedHead),
    cursor: (remote: SyncEvent.DeviceID) => Effect.succeed(cursors.get(remote) ?? 0),
    apply: (segment: SyncEvent.Segment) =>
      Effect.sync(() => {
        for (const operation of segment.operations) if (operation.kind === "event") applied.push(operation.event)
        cursors.set(segment.deviceID, segment.generation)
      }),
    applyDurable: (segment: SyncEvent.Segment) =>
      Effect.sync(() => {
        knownSegments.push(segment)
        for (const operation of segment.operations) if (operation.kind === "event") applied.push(operation.event)
        cursors.set(segment.deviceID, segment.generation)
      }),
    pendingApply: () => Effect.succeed([]),
    deletions: () => Effect.succeed(deletions),
    segmentsFor: (sessionIDs: readonly string[]) =>
      Effect.succeed(
        knownSegments.flatMap((segment) =>
          segment.operations.some((operation) =>
            sessionIDs.includes(
              operation.kind === "tombstone" ? operation.tombstone.sessionID : operation.event.aggregateID,
            ),
          )
            ? [{ deviceID: segment.deviceID, generation: segment.generation }]
            : [],
        ),
      ),
    absorbDeletions: (items: readonly SyncEvent.Tombstone[], projector: SyncEvent.DurableProjector) =>
      Effect.gen(function* () {
        for (const item of items) {
          if (!deletions.some((known) => known.sessionID === item.sessionID)) deletions.push(item)
          yield* projector.delete(item)
        }
      }),
    forgetDeletion: (sessionID: string) =>
      Effect.sync(() => {
        const index = deletions.findIndex((item) => item.sessionID === sessionID)
        if (index >= 0) deletions.splice(index, 1)
      }),
    acquire: () => Effect.succeed(true),
    renew: () => Effect.succeed(true),
    release: () => Effect.void,
  } as any
  return { service, applied }
}

describe("SyncRuntime", () => {
  test("waits for a cross-process upload lease and then drains pending work", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("lease-wait")
    const local = store(id, {
      id: "evt_lease_wait" as any,
      aggregateID: "session-lease-wait",
      seq: 0,
      type: "session.created",
      data: { title: "queued while another process uploads" },
    })
    let uploadAttempts = 0
    const leasedStore = {
      ...local.service,
      acquire: ((kind: string, ...args: unknown[]) => {
        if (kind === "upload" && uploadAttempts++ === 0) return Effect.succeed(false)
        return local.service.acquire(kind, ...args)
      }) as typeof local.service.acquire,
    }
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: leasedStore,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })

    await Effect.runPromise(runtime.now())

    expect(uploadAttempts).toBe(2)
    expect([...remote.files.keys()].some((path) => path.includes("segments/lease-wait/1-1"))).toBeTrue()
  })

  test("drains every queued segment in one upload run", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("drain")
    const local = store(id)
    let remaining = 3
    let generation = 0
    local.service.seal = () =>
      Effect.sync(() => {
        if (remaining === 0) return undefined
        const next = ++generation
        return SyncEvent.Segment.make({
          version: 1,
          id: SyncEvent.SegmentID.make(`${id}:${next}`),
          deviceID: id,
          generation: next,
          createdAt: next,
          operations: [],
        })
      })
    local.service.acknowledge = () => Effect.sync(() => void remaining--)
    local.service.head = () => Effect.sync(() => generation)
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: local.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })

    await Effect.runPromise(runtime.upload())

    expect([...remote.files.keys()].filter((item) => item.startsWith(`segments/${id}/`))).toHaveLength(3)
    expect(remaining).toBe(0)
  })

  test("never lets a stale process regress its device head", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("shared-device")
    const makeRuntime = (generation: number) => {
      const local = store(id)
      local.service.head = () => Effect.succeed(generation)
      return SyncRuntime.make({
        config: { deviceID: id, enabled: true },
        codec: SyncCodec.plaintext(),
        provider: remote.adapter,
        store: local.service,
        projector: { project: () => Effect.void, delete: () => Effect.void },
        metadata: () => Effect.succeed([]),
        metadataProjector: { apply: () => Effect.void },
      })
    }

    await Effect.runPromise(makeRuntime(381).upload())
    await Effect.runPromise(makeRuntime(271).upload())

    const path = `devices/${id}.head.json`
    const stored = remote.files.get(path)!
    const raw = await SyncCodec.plaintext().open(
      "metadata",
      { path, type: "head", deviceID: id, generation: 0, range: "head", schemaVersion: 1 },
      stored.bytes,
    )
    expect(JSON.parse(new TextDecoder().decode(raw)).generation).toBe(381)
  })

  test("does not republish an unchanged head or scan attachment history", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("idle-device")
    const local = store(id)
    let collections = 0
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: local.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
      attachment: {
        externalize: async (event) => event,
        references: () => new Set(),
        collect: async () => void collections++,
      },
    })

    await Effect.runPromise(runtime.upload())
    await Effect.runPromise(runtime.upload())
    await Effect.runPromise(
      SyncRuntime.make({
        config: { deviceID: id, enabled: true },
        codec: SyncCodec.plaintext(),
        provider: remote.adapter,
        store: local.service,
        projector: { project: () => Effect.void, delete: () => Effect.void },
        metadata: () => Effect.succeed([]),
        metadataProjector: { apply: () => Effect.void },
      }).upload(),
    )

    expect(remote.counts.upload).toBe(1)
    expect(collections).toBe(0)
  })

  test("includes safe provider identifiers in diagnostics", () => {
    expect(
      SyncRuntime.diagnostic(
        "segment",
        new SyncProvider.ProviderError("baidu", "upload", "provider", false, "failed", undefined, 31326, "998877"),
      ),
    ).toMatchObject({
      message: "Baidu Netdisk upload failed: provider rejected the request (code 31326, request 998877)",
    })
    expect(
      SyncRuntime.diagnostic(
        "segment",
        new SyncProvider.ProviderError(
          "baidu",
          "upload",
          "provider",
          false,
          "unknown",
          undefined,
          undefined,
          "header-request",
          "part-upload",
          400,
        ),
      ),
    ).toMatchObject({
      message: "Baidu Netdisk part-upload failed: provider rejected the request (HTTP 400, request header-request)",
    })
  })

  test("uses the plaintext codec without requiring a recovery key", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("mac")
    const event = SyncEvent.Envelope.make({
      id: "plain-event",
      aggregateID: "plain-session",
      seq: 0,
      type: "session.created",
      data: { title: "visible title" },
    })
    const local = store(id, event)
    const progress: SyncTransferEvent.Progress[] = []
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: local.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
      transfer: SyncTransfer.make(async (value) => void progress.push(value)),
    })
    await Effect.runPromise(runtime.upload())
    expect([...remote.files.keys()].some((item) => item.endsWith(".json"))).toBeTrue()
    expect(progress).toEqual([
      { state: "active", direction: "upload", phase: "sessions" },
      expect.objectContaining({ state: "active", direction: "upload", phase: "sessions", items: 1 }),
      { state: "idle" },
    ])
  })

  test("does not report routine head-only polling as a transfer", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("quiet")
    const progress: SyncTransferEvent.Progress[] = []
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: store(id).service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
      transfer: SyncTransfer.make(async (value) => void progress.push(value)),
    })

    await Effect.runPromise(runtime.now())
    expect(progress).toEqual([])
  })

  test("reuses an unchanged remote head and refreshes it when its version changes", async () => {
    const remote = provider()
    const macID = SyncEvent.DeviceID.make("cached-head-mac")
    const windowsID = SyncEvent.DeviceID.make("cached-head-windows")
    let title = "first"
    const uploader = SyncRuntime.make({
      config: { deviceID: macID, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: store(macID).service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () =>
        Effect.succeed([
          {
            sessionID: "session-1",
            title,
            ownerDeviceID: macID,
            directory: "/workspace",
            revision: 1,
            updatedAt: 1,
          },
        ]),
      metadataProjector: { apply: () => Effect.void },
    })
    const downloader = SyncRuntime.make({
      config: { deviceID: windowsID, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: store(windowsID).service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })

    await Effect.runPromise(uploader.upload())
    await Effect.runPromise(downloader.pull())
    const afterFirstPull = remote.counts.download
    await Effect.runPromise(downloader.pull())
    expect(remote.counts.download).toBe(afterFirstPull)

    title = "second"
    await Effect.runPromise(uploader.upload())
    const beforeRefresh = remote.counts.download
    await Effect.runPromise(downloader.pull())
    expect(remote.counts.download).toBe(beforeRefresh + 1)
  })

  test("retries a mutable device head that changes between list and download", async () => {
    const remote = provider()
    const macID = SyncEvent.DeviceID.make("head-mac")
    const windowsID = SyncEvent.DeviceID.make("head-windows")
    const uploader = SyncRuntime.make({
      config: { deviceID: macID, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: remote.adapter,
      store: store(macID).service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })
    await Effect.runPromise(uploader.upload())

    let conflicts = 0
    const flaky: SyncProvider.Adapter = {
      ...remote.adapter,
      download: async (path, version, signal) => {
        if (path.startsWith("devices/") && conflicts++ === 0)
          throw new SyncProvider.ProviderError("memory", "download", "conflict", false)
        return remote.adapter.download(path, version, signal)
      },
    }
    const downloader = SyncRuntime.make({
      config: { deviceID: windowsID, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: flaky,
      store: store(windowsID).service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })

    await Effect.runPromise(downloader.pull())
    expect(conflicts).toBe(2)
  })

  test("uploads encrypted heads and segments, then hydrates metadata and events", async () => {
    const remote = provider()
    const space = SyncCrypto.createSpace()
    const macID = SyncEvent.DeviceID.make("mac")
    const winID = SyncEvent.DeviceID.make("windows")
    const event = SyncEvent.Envelope.make({
      id: "event-1",
      aggregateID: "session-1",
      seq: 0,
      type: "session.created",
      data: { title: "secret title" },
    })
    const mac = store(macID, event)
    const metadata = [
      {
        sessionID: "session-1",
        title: "secret title",
        ownerDeviceID: "mac",
        directory: "/secret/path",
        revision: 1,
        updatedAt: 1,
      },
    ]
    const uploader = SyncRuntime.make({
      config: { deviceID: macID, enabled: true },
      rootKey: space.rootKey,
      provider: remote.adapter,
      store: mac.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed(metadata),
      metadataProjector: { apply: () => Effect.void },
    })
    await Effect.runPromise(uploader.upload())
    const cloud = new TextDecoder().decode(Buffer.concat([...remote.files.values()].map((item) => item.bytes)))
    expect(cloud).not.toContain("secret title")
    expect(cloud).not.toContain("/secret/path")

    const windows = store(winID)
    let projected: readonly SyncRuntime.Metadata[] = []
    const downloader = SyncRuntime.make({
      config: { deviceID: winID, enabled: true },
      rootKey: space.rootKey,
      provider: remote.adapter,
      store: windows.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: (value) => Effect.sync(() => void (projected = value)) },
    })
    await Effect.runPromise(downloader.pull())
    expect(projected[0]?.title).toBe("secret title")
    expect(windows.applied).toEqual([])
    await Effect.runPromise(downloader.hydrate())
    expect(windows.applied).toEqual([event])
    expect(downloader.status().lastPullAt).toBeNumber()
  })

  test("coalesces concurrent uploads and disabled sync never touches the provider", async () => {
    const remote = provider()
    let uploads = 0
    const adapter = {
      ...remote.adapter,
      uploadAtomic: async (...args: Parameters<SyncProvider.Adapter["uploadAtomic"]>) => {
        uploads++
        return remote.adapter.uploadAtomic(...args)
      },
    }
    const id = SyncEvent.DeviceID.make("device")
    const local = store(id)
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: false },
      rootKey: SyncCrypto.createSpace().rootKey,
      provider: adapter,
      store: local.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })
    await Promise.all([Effect.runPromise(runtime.upload()), Effect.runPromise(runtime.upload())])
    expect(uploads).toBe(0)
  })

  test("recovers when cloud segment committed before local acknowledgement", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("mac")
    const event = SyncEvent.Envelope.make({
      id: "event",
      aggregateID: "session",
      seq: 0,
      type: "session.created",
      data: {},
    })
    const local = store(id, event)
    let acknowledgements = 0
    const original = local.service.acknowledge
    local.service.acknowledge = (segmentID: SyncEvent.SegmentID) =>
      ++acknowledgements === 1 ? Effect.fail(new Error("crash before ack")) : original(segmentID)
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      rootKey: SyncCrypto.createSpace().rootKey,
      provider: remote.adapter,
      store: local.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })
    await expect(Effect.runPromise(runtime.upload())).rejects.toBeDefined()
    const objects = remote.files.size
    await Effect.runPromise(runtime.upload())
    expect(remote.files.size).toBe(objects + 1) // only the newly written head
  })

  test("resumes a partial large-attachment upload through segment, head, acknowledgement and hydration", async () => {
    const remote = provider()
    const macID = SyncEvent.DeviceID.make("mac")
    const windowsID = SyncEvent.DeviceID.make("windows")
    const output = "large persistent output ".repeat(8_000)
    const events = [0, 1].map((seq) =>
      SyncEvent.Envelope.make({
        id: `large-event-${seq}`,
        aggregateID: "large-session",
        seq,
        type: "session.part.updated",
        data: { part: { type: "tool", state: { status: "completed", output } } },
      }),
    )
    const mac = store(
      macID,
      undefined,
      events.map((event) => SyncEvent.EventOperation.make({ kind: "event", event })),
    )
    let acknowledgements = 0
    const acknowledge = mac.service.acknowledge
    mac.service.acknowledge = (segmentID: SyncEvent.SegmentID) => {
      acknowledgements++
      return acknowledge(segmentID)
    }
    mac.service.head = () => Effect.succeed(acknowledgements ? 1 : 0)
    let failManifest = true
    const adapter: SyncProvider.Adapter = {
      ...remote.adapter,
      uploadAtomic: async (...args) => {
        if (args[0].startsWith("chunks/manifests/") && failManifest) {
          failManifest = false
          throw new SyncProvider.ProviderError("memory", "upload", "network", true, "unknown")
        }
        return remote.adapter.uploadAtomic(...args)
      },
    }
    const sourceAttachment = SyncAttachment.make({
      codec: SyncCodec.plaintext(),
      namespaceID: "space",
      provider: adapter,
    })
    const metadata = [
      {
        sessionID: "large-session",
        title: "large",
        ownerDeviceID: "mac",
        directory: "/project",
        revision: 1,
        updatedAt: 1,
      },
    ]
    const source = SyncRuntime.make({
      config: { deviceID: macID, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: adapter,
      store: mac.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed(metadata),
      metadataProjector: { apply: () => Effect.void },
      attachment: {
        externalize: (item) => SessionSync.externalize(item, sourceAttachment),
        references: SyncAttachment.references,
        collect: sourceAttachment.collect,
      },
    })

    await expect(Effect.runPromise(source.now())).rejects.toBeDefined()
    expect(source.status().lastError).toEqual({
      stage: "attachment",
      operation: "upload",
      kind: "network",
      retryable: true,
      outcome: "unknown",
      retryAfter: undefined,
      message: "Sync attachment failed",
    })
    expect(acknowledgements).toBe(0)
    expect([...remote.files.keys()].some((path) => path.startsWith("chunks/"))).toBeTrue()
    expect([...remote.files.keys()].some((path) => path.startsWith("chunks/manifests/"))).toBeFalse()

    await Effect.runPromise(source.now())
    expect(acknowledgements).toBe(1)
    expect([...remote.files.keys()].some((path) => path.startsWith("segments/"))).toBeTrue()
    expect([...remote.files.keys()].some((path) => path.startsWith("devices/"))).toBeTrue()

    const windows = store(windowsID)
    const targetAttachment = SyncAttachment.make({
      codec: SyncCodec.plaintext(),
      namespaceID: "space",
      provider: adapter,
    })
    let discovered: readonly SyncRuntime.Metadata[] = []
    const target = SyncRuntime.make({
      config: { deviceID: windowsID, enabled: true },
      codec: SyncCodec.plaintext(),
      provider: adapter,
      store: windows.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: (items) => Effect.sync(() => void (discovered = items)) },
      attachment: {
        externalize: (item) => SessionSync.externalize(item, targetAttachment),
        references: SyncAttachment.references,
        collect: targetAttachment.collect,
      },
    })
    await Effect.runPromise(target.pull())
    expect(discovered).toEqual(metadata)
    await Effect.runPromise(target.hydrate())
    expect(windows.applied).toHaveLength(2)
    expect(
      await Promise.all(windows.applied.map((event) => SyncAttachment.hydrate(event.data, targetAttachment))),
    ).toEqual(events.map((event) => event.data))
  })

  test("commits attachment references without rescanning unchanged history", async () => {
    const remote = provider()
    const space = SyncCrypto.createSpace()
    const macID = SyncEvent.DeviceID.make("mac")
    const winID = SyncEvent.DeviceID.make("windows")
    const event = SyncEvent.Envelope.make({
      id: "event",
      aggregateID: "session",
      seq: 0,
      type: "session.part.updated",
      data: { part: { url: "data:image/png;base64,aGVsbG8=" } },
    })
    const mac = store(macID, event)
    const collected: any[] = []
    const attachment = {
      externalize: async (value: SyncEvent.Envelope) =>
        SyncEvent.Envelope.make({ ...value, data: { part: { url: "opencode-sync-attachment://image" } } }),
      references: (value: unknown) =>
        JSON.stringify(value).includes("opencode-sync-attachment://image")
          ? new Set<string>(["image"])
          : new Set<string>(),
      collect: async (input: unknown) => void collected.push(input),
    }
    const uploader = SyncRuntime.make({
      config: { deviceID: macID, enabled: true },
      rootKey: space.rootKey,
      provider: remote.adapter,
      store: mac.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
      acknowledged: () => Effect.succeed({}),
      attachment,
    })
    await Effect.runPromise(uploader.upload())
    expect(collected).toEqual([])

    const windows = store(winID)
    const gated: any[] = []
    const downloader = SyncRuntime.make({
      config: { deviceID: winID, enabled: true },
      rootKey: space.rootKey,
      provider: remote.adapter,
      store: windows.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
      acknowledged: () => Effect.succeed({}),
      attachment: { ...attachment, collect: async (input: unknown) => void gated.push(input) },
    })
    await Effect.runPromise(downloader.now())
    expect(gated).toEqual([])
  })

  test("does not retain attachment references belonging to globally deleted sessions", async () => {
    const remote = provider()
    const id = SyncEvent.DeviceID.make("mac")
    const local = store(id, undefined, [
      {
        kind: "event",
        event: SyncEvent.Envelope.make({
          id: "event",
          aggregateID: "deleted-session",
          seq: 0,
          type: "session.part.updated",
          data: { ref: "opencode-sync-attachment://old" },
        }),
      },
      {
        kind: "tombstone",
        tombstone: SyncEvent.Tombstone.make({ id: "delete", sessionID: "deleted-session", deletedAt: 2 }),
      },
    ])
    const collected: any[] = []
    const runtime = SyncRuntime.make({
      config: { deviceID: id, enabled: true },
      rootKey: SyncCrypto.createSpace().rootKey,
      provider: remote.adapter,
      store: local.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
      acknowledged: () => Effect.succeed({}),
      attachment: {
        externalize: async (event) => event,
        references: () => new Set(["old"]),
        collect: async (input) => void collected.push(input),
      },
    })
    await Effect.runPromise(runtime.upload())
    expect(collected[0]).toMatchObject({ liveObjectIDs: new Set(), allActiveDevicesAcknowledged: true })
  })

  test("prevents a stale device from resurrecting deleted metadata for a third device", async () => {
    const remote = provider()
    const codec = SyncCodec.plaintext()
    const sessionID = "deleted-session"
    const tombstone = SyncEvent.Tombstone.make({ id: "delete-on-a", sessionID, deletedAt: 2 })
    const stale = SyncEvent.Envelope.make({
      id: "stale-on-b",
      aggregateID: sessionID,
      seq: 0,
      type: "session.created",
      data: { title: "must not return" },
    })
    const deviceB = store(SyncEvent.DeviceID.make("b"), stale)
    let visibleOnB = true
    const runtimeB = SyncRuntime.make({
      config: { deviceID: SyncEvent.DeviceID.make("b"), enabled: true },
      codec,
      provider: remote.adapter,
      store: deviceB.service,
      projector: {
        project: () => Effect.void,
        delete: () => Effect.sync(() => void (visibleOnB = false)),
      },
      metadata: () =>
        Effect.succeed(
          visibleOnB
            ? [
                {
                  sessionID,
                  title: "must not return",
                  ownerDeviceID: "b",
                  directory: "/stale",
                  revision: 1,
                  updatedAt: 1,
                },
              ]
            : [],
        ),
      metadataProjector: { apply: () => Effect.void },
    })
    // B first publishes a reference, then goes offline while A deletes the
    // Session. A must retain the marker and payload until B returns.
    await Effect.runPromise(runtimeB.upload())

    const deviceA = store(SyncEvent.DeviceID.make("a"), undefined, [{ kind: "tombstone", tombstone }])
    const runtimeA = SyncRuntime.make({
      config: { deviceID: SyncEvent.DeviceID.make("a"), enabled: true },
      codec,
      provider: remote.adapter,
      store: deviceA.service,
      projector: { project: () => Effect.void, delete: () => Effect.void },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: () => Effect.void },
    })
    await Effect.runPromise(runtimeA.upload())
    expect([...remote.files.keys()].some((path) => path === `deletions/${sessionID}/marker.json`)).toBeTrue()

    // Pulling applies the deletion locally, but is deliberately not enough to
    // release B's reference: its stale remote head has not been replaced yet.
    await Effect.runPromise(runtimeB.pull())
    expect(visibleOnB).toBeFalse()
    expect([...remote.files.keys()].some((path) => path === `deletions/${sessionID}/acks/b.json`)).toBeFalse()
    expect([...remote.files.keys()].some((path) => path === `deletions/${sessionID}/marker.json`)).toBeTrue()

    await Effect.runPromise(runtimeB.upload())
    expect([...remote.files.keys()].some((path) => path.startsWith(`deletions/${sessionID}/`))).toBeFalse()

    const deviceC = store(SyncEvent.DeviceID.make("c"))
    const visibleOnC: SyncRuntime.Metadata[] = []
    let deletedOnC = false
    const runtimeC = SyncRuntime.make({
      config: { deviceID: SyncEvent.DeviceID.make("c"), enabled: true },
      codec,
      provider: remote.adapter,
      store: deviceC.service,
      projector: {
        project: () => Effect.void,
        delete: () => Effect.sync(() => void (deletedOnC = true)),
      },
      metadata: () => Effect.succeed([]),
      metadataProjector: { apply: (items) => Effect.sync(() => void visibleOnC.push(...items)) },
    })
    await Effect.runPromise(runtimeC.pull())
    expect(deletedOnC).toBeFalse()
    expect(visibleOnC.some((item) => item.sessionID === sessionID)).toBeFalse()
    expect(deviceC.applied).toEqual([])
  })
})
