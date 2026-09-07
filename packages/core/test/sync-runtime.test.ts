import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRuntime } from "@opencode-ai/core/sync/runtime"
import { SyncCodec } from "@opencode-ai/core/sync/codec"

function provider() {
  const files = new Map<string, { bytes: Uint8Array; version: number }>()
  const adapter: SyncProvider.Adapter = {
    id: "memory",
    list: async (prefix) => ({
      objects: [...files]
        .filter(([path]) => path.startsWith(prefix))
        .map(([path, value]) => ({ path, version: String(value.version), size: value.bytes.length })),
    }),
    stat: async (path) => {
      const value = files.get(path)
      return value && { path, version: String(value.version), size: value.bytes.length }
    },
    download: async (path, version) => {
      const value = files.get(path)
      if (!value || (version && version !== String(value.version))) throw new Error("missing")
      return { path, version: String(value.version), size: value.bytes.length, bytes: value.bytes }
    },
    uploadAtomic: async (path, bytes, precondition) => {
      const current = files.get(path)
      if (precondition.type === "absent" && current) throw new Error("exists")
      if (precondition.type === "version" && String(current?.version) !== precondition.version)
        throw new Error("conflict")
      const value = { bytes: bytes.slice(), version: (current?.version ?? 0) + 1 }
      files.set(path, value)
      return { path, version: String(value.version), size: bytes.length }
    },
    deleteBatch: async () => [],
  }
  return { adapter, files }
}

function store(deviceID: SyncEvent.DeviceID, event?: SyncEvent.Envelope, operations?: readonly SyncEvent.Operation[]) {
  let local = event
  let sealed: SyncEvent.Segment | undefined
  const cursors = new Map<string, number>()
  const applied: SyncEvent.Envelope[] = []
  const service = {
    enqueue: () => Effect.void,
    delete: () => Effect.void,
    pending: () => Effect.succeed(local ? [local] : []),
    seal: (_deviceID: SyncEvent.DeviceID) =>
      Effect.sync(() => {
        if (sealed) return sealed
        if (!local && !operations) return undefined
        return (sealed = SyncEvent.Segment.make({
          version: 1,
          id: SyncEvent.SegmentID.make(`${deviceID}:1`),
          deviceID,
          generation: 1,
          createdAt: 1,
          operations: operations ?? [{ kind: "event", event: local! }],
        }))
      }),
    acknowledge: () => Effect.sync(() => void (local = undefined)),
    head: () => Effect.succeed(sealed ? 1 : 0),
    cursor: (remote: SyncEvent.DeviceID) => Effect.succeed(cursors.get(remote) ?? 0),
    apply: (segment: SyncEvent.Segment) =>
      Effect.sync(() => {
        for (const operation of segment.operations) if (operation.kind === "event") applied.push(operation.event)
        cursors.set(segment.deviceID, segment.generation)
      }),
    applyDurable: (segment: SyncEvent.Segment) =>
      Effect.sync(() => {
        for (const operation of segment.operations) if (operation.kind === "event") applied.push(operation.event)
        cursors.set(segment.deviceID, segment.generation)
      }),
    pendingApply: () => Effect.succeed([]),
    acquire: () => Effect.succeed(true),
    renew: () => Effect.succeed(true),
    release: () => Effect.void,
  } as any
  return { service, applied }
}

describe("SyncRuntime", () => {
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
    expect([...remote.files.keys()].some((item) => item.endsWith(".json"))).toBeTrue()
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

  test("commits attachment references before segments and gates collection on device acknowledgements", async () => {
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
    expect(collected[0]).toMatchObject({ liveObjectIDs: new Set(["image"]), allActiveDevicesAcknowledged: true })

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
    await Effect.runPromise(downloader.pull())
    expect(gated[0]).toMatchObject({ liveObjectIDs: new Set(["image"]), allActiveDevicesAcknowledged: false })
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
})
