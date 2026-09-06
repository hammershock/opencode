import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRuntime } from "@opencode-ai/core/sync/runtime"

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

function store(deviceID: SyncEvent.DeviceID, event?: SyncEvent.Envelope) {
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
        if (!local) return undefined
        return (sealed = SyncEvent.Segment.make({
          version: 1,
          id: SyncEvent.SegmentID.make(`${deviceID}:1`),
          deviceID,
          generation: 1,
          createdAt: 1,
          operations: [{ kind: "event", event: local }],
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
})
