import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { SyncControlLog } from "@opencode-ai/core/sync/control-log"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEvent } from "@opencode-ai/core/sync/event"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { tmpdir } from "./fixture/tmpdir"
import { createHash } from "node:crypto"

const device = (value: string) => SyncEvent.DeviceID.make(value)

describe("SyncControlLog", () => {
  test("replays an append-only membership and deletion chain into SQLite", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases([path.join(tmp.path, "a.db"), path.join(tmp.path, "b.db")], async ([aDB, bDB]) => {
      const a = SyncControlLog.make({ provider: remote.adapter, db: aDB, spaceID: "account" })
      const b = SyncControlLog.make({ provider: remote.adapter, db: bDB, spaceID: "account" })

      await a.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      expect((await a.append())?.generation).toBe(1)
      await b.replay()
      await b.enqueue(intent("join-b", "b", join("b", "install-b", "Windows"), 2))
      expect((await b.append())?.generation).toBe(2)
      await a.replay()

      expect(await a.membership()).toMatchObject({ generation: 2, devices: ["a", "b"] })
      const tombstone = SyncEvent.Tombstone.make({ id: "delete-session", sessionID: "session", deletedAt: 3 })
      await a.enqueue(intent("delete", "a", await a.sessionDelete(tombstone), 3))
      const deletion = await a.append()
      expect(deletion).toMatchObject({ generation: 3, operation: { kind: "session.delete" } })
      if (!deletion) throw new Error("missing deletion")
      const headA = checkpointHead("a", 7)
      const ackA = await a.prepareAcknowledgement({
        kind: "session.ack",
        tombstoneID: tombstone.id,
        sessionID: tombstone.sessionID,
        deleteGeneration: deletion.generation,
        deviceID: device("a"),
        headGeneration: 7,
        headDigest: stableDigest(headA),
      }, headA)
      await a.ensureFence(ackA)
      await a.enqueue(
        intent(
          "ack-a",
          "a",
          ackA,
          4,
        ),
      )
      await a.append()
      await b.replay()
      const headB = checkpointHead("b", 9)
      const ackB = await b.prepareAcknowledgement({
        kind: "session.ack",
        tombstoneID: tombstone.id,
        sessionID: tombstone.sessionID,
        deleteGeneration: deletion.generation,
        deviceID: device("b"),
        headGeneration: 9,
        headDigest: stableDigest(headB),
      }, headB)
      await b.ensureFence(ackB)
      await b.enqueue(
        intent(
          "ack-b",
          "b",
          ackB,
          5,
        ),
      )
      await b.append()
      await a.replay()
      const gc = await a.sessionGC(deletion)
      expect(gc).toBeDefined()
      if (!gc) throw new Error("missing GC operation")
      await a.enqueue(
        intent("gc", "a", gc, 6),
      )

      expect((await a.drain()).map((entry) => entry.operation.kind)).toEqual(["session.gc"])

      await b.replay()
      const replayedDeletion = (await b.entries()).find((entry) => entry.operation.kind === "session.delete")
      expect(replayedDeletion?.operation).toMatchObject({
        membershipDigest: (await b.membership()).digest,
        requiredDevices: ["a", "b"],
      })
      expect(await b.cursor()).toEqual(await a.cursor())
    })
  })

  test("rebases concurrent intents after one immutable slot wins", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases([path.join(tmp.path, "a.db"), path.join(tmp.path, "b.db")], async ([aDB, bDB]) => {
      const a = SyncControlLog.make({ provider: remote.adapter, db: aDB, spaceID: "account" })
      const b = SyncControlLog.make({ provider: remote.adapter, db: bDB, spaceID: "account" })
      await a.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      await a.append()
      await b.replay()
      await b.enqueue(intent("join-b", "b", join("b", "install-b", "Windows"), 2))
      await b.append()
      await a.replay()

      await a.enqueue(intent("rename-a", "a", { kind: "device.rename", deviceID: device("a"), name: "Mac 2" }, 3))
      await b.enqueue(intent("rename-b", "b", { kind: "device.rename", deviceID: device("b"), name: "Windows 2" }, 3))
      const committed = await Promise.all([a.append(), b.append()])
      expect(new Set(committed.map((entry) => entry?.generation))).toEqual(new Set([3, 4]))

      await Promise.all([a.replay(), b.replay()])
      expect(await a.members()).toEqual(await b.members())
      expect((await a.members()).map((member) => member.name)).toEqual(["Mac 2", "Windows 2"])
      expect(remote.paths()).toEqual([
        "control/v2/log/00000000000000000001.json",
        "control/v2/log/00000000000000000002.json",
        "control/v2/log/00000000000000000003.json",
        "control/v2/log/00000000000000000004.json",
      ])
    })
  })

  test("resolves an unknown immutable-create result by exact content", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    let unknown = true
    const adapter: SyncProvider.Adapter = {
      ...remote.adapter,
      async uploadAtomic(path, bytes, precondition, signal) {
        const result = await remote.adapter.uploadAtomic(path, bytes, precondition, signal)
        if (!unknown) return result
        unknown = false
        throw new SyncProvider.ProviderError("memory", "upload", "network", true, "unknown")
      },
    }
    await withDatabases([path.join(tmp.path, "sync.db")], async ([db]) => {
      const log = SyncControlLog.make({ provider: adapter, db, spaceID: "account" })
      await log.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      expect((await log.append())?.operationID).toBe("join-a")
      expect(await log.cursor()).toMatchObject({ generation: 1 })
      expect(await log.append()).toBeUndefined()
    })
  })

  test("recomputes a deletion fence when a concurrent join wins the preceding slot", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases(
      [path.join(tmp.path, "a.db"), path.join(tmp.path, "b.db"), path.join(tmp.path, "c.db")],
      async ([aDB, bDB, cDB]) => {
        const a = SyncControlLog.make({ provider: remote.adapter, db: aDB, spaceID: "account" })
        const b = SyncControlLog.make({ provider: remote.adapter, db: bDB, spaceID: "account" })
        const c = SyncControlLog.make({ provider: remote.adapter, db: cDB, spaceID: "account" })
        await a.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
        await a.append()
        await b.replay()
        await b.enqueue(intent("join-b", "b", join("b", "install-b", "Windows"), 2))
        await b.append()
        await Promise.all([a.replay(), c.replay()])

        const tombstone = SyncEvent.Tombstone.make({ id: "delete", sessionID: "session", deletedAt: 3 })
        await a.enqueue(intent("delete", "a", await a.sessionDelete(tombstone), 3))
        await c.enqueue(intent("join-c", "c", join("c", "install-c", "Linux"), 3))
        // Promise evaluation is left-to-right and the in-memory provider's
        // immutable create has no await before claiming the slot, so C wins 3.
        await Promise.all([c.append(), a.append()])
        await a.replay()

        const deletion = (await a.entries()).find((entry) => entry.operation.kind === "session.delete")
        expect(deletion).toMatchObject({ generation: 4 })
        expect(deletion?.operation).toMatchObject({ requiredDevices: ["a", "b", "c"] })
      },
    )
  })

  test("does not trust a stale membership fence stored in a local deletion intent", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases([path.join(tmp.path, "sync.db")], async ([db]) => {
      const log = SyncControlLog.make({ provider: remote.adapter, db, spaceID: "account" })
      await log.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      await log.append()
      await log.enqueue(
        intent(
          "bad-delete",
          "a",
          {
            kind: "session.delete",
            tombstone: SyncEvent.Tombstone.make({ id: "bad-delete", sessionID: "session", deletedAt: 2 }),
            requiredDevices: [],
            membershipDigest: "wrong",
          },
          2,
        ),
      )
      const committed = await log.append()
      expect(committed?.operation).toMatchObject({ requiredDevices: ["a"] })
      expect(committed?.operation).not.toMatchObject({ membershipDigest: "wrong" })
      expect((await log.cursor()).generation).toBe(2)
    })
  })

  test("collapses concurrent deletes of one Session onto the first immutable deletion", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases([path.join(tmp.path, "a.db"), path.join(tmp.path, "b.db")], async ([aDB, bDB]) => {
      const a = SyncControlLog.make({ provider: remote.adapter, db: aDB, spaceID: "account" })
      const b = SyncControlLog.make({ provider: remote.adapter, db: bDB, spaceID: "account" })
      await a.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      await a.append()
      await b.replay()
      await b.enqueue(intent("join-b", "b", join("b", "install-b", "Windows"), 2))
      await b.append()
      await a.replay()

      const left = SyncEvent.Tombstone.make({ id: "delete-a", sessionID: "same-session", deletedAt: 3 })
      const right = SyncEvent.Tombstone.make({ id: "delete-b", sessionID: "same-session", deletedAt: 3 })
      await a.enqueue(intent(left.id, "a", await a.sessionDelete(left), 3))
      await b.enqueue(intent(right.id, "b", await b.sessionDelete(right), 3))
      const committed = await Promise.all([a.append(), b.append()])
      await Promise.all([a.replay(), b.replay()])

      expect(new Set(committed.map((entry) => entry?.generation))).toEqual(new Set([3]))
      expect((await a.deletionEntries()).filter((entry) => entry.operation.kind === "session.delete")).toHaveLength(1)
      expect(await a.append()).toBeUndefined()
      expect(await b.append()).toBeUndefined()
      expect(remote.paths()).toHaveLength(3)
    })
  })

  test("reuses one prepared head checkpoint across a crash and later head changes", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases([path.join(tmp.path, "sync.db")], async ([db]) => {
      const log = SyncControlLog.make({ provider: remote.adapter, db, spaceID: "account" })
      await log.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      await log.append()
      const tombstone = SyncEvent.Tombstone.make({ id: "delete", sessionID: "session", deletedAt: 2 })
      await log.enqueue(intent("delete", "a", await log.sessionDelete(tombstone), 2))
      const deletion = await log.append()
      if (!deletion) throw new Error("missing deletion")

      const firstHead = checkpointHead("a", 4)
      const prepared = await log.prepareAcknowledgement(
        {
          kind: "session.ack",
          tombstoneID: tombstone.id,
          sessionID: tombstone.sessionID,
          deleteGeneration: deletion.generation,
          deviceID: device("a"),
          headGeneration: 4,
          headDigest: stableDigest(firstHead),
        },
        firstHead,
      )
      await log.ensureFence(prepared)

      const laterHead = checkpointHead("a", 5)
      const recovered = await log.prepareAcknowledgement(
        {
          kind: "session.ack",
          tombstoneID: tombstone.id,
          sessionID: tombstone.sessionID,
          deleteGeneration: deletion.generation,
          deviceID: device("a"),
          headGeneration: 5,
          headDigest: stableDigest(laterHead),
        },
        laterHead,
      )
      expect(recovered).toEqual(prepared)
      await log.ensureFence(recovered)
      await log.enqueue(intent("ack", "a", recovered, 3))
      expect((await log.append())?.operation).toEqual(prepared)
      expect(await log.sessionGC(deletion)).toBeDefined()
    })
  })

  test("quarantines an invalid revoked-device intent before it can occupy a cloud slot", async () => {
    await using tmp = await tmpdir()
    const remote = memory()
    await withDatabases([path.join(tmp.path, "a.db"), path.join(tmp.path, "b.db")], async ([aDB, bDB]) => {
      const a = SyncControlLog.make({ provider: remote.adapter, db: aDB, spaceID: "account" })
      const b = SyncControlLog.make({ provider: remote.adapter, db: bDB, spaceID: "account" })
      await a.enqueue(intent("join-a", "a", join("a", "install-a", "Mac"), 1))
      await a.append()
      await b.replay()
      await b.enqueue(intent("join-b", "b", join("b", "install-b", "Windows"), 2))
      await b.append()
      await a.replay()
      await a.enqueue(intent("revoke-b", "a", { kind: "device.revoke", deviceID: device("b") }, 3))
      await a.append()
      await b.replay()

      await b.enqueue(intent("rename-after-revoke", "b", { kind: "device.rename", deviceID: device("b"), name: "bad" }, 4))
      await expect(b.append()).rejects.toThrow("not an active member")
      expect(await b.append()).toBeUndefined()
      expect(remote.paths()).toHaveLength(3)
    })
  })
})

function intent(id: string, actor: string, operation: SyncControlLog.Operation, createdAt: number) {
  return SyncControlLog.Intent.make({
    version: 2,
    operationID: id,
    actorDeviceID: device(actor),
    createdAt,
    operation,
  })
}

function join(id: string, installationID: string, name: string) {
  return SyncControlLog.DeviceJoin.make({ kind: "device.join", deviceID: device(id), installationID, name })
}

function checkpointHead(id: string, generation: number) {
  return {
    version: 1 as const,
    deviceID: device(id),
    deviceName: id,
    generation,
    acknowledged: {},
    metadata: [],
    deletions: [],
    revoked: [],
  }
}

function stableDigest(value: unknown) {
  return createHash("sha256").update(canonical(value)).digest("hex")
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}

async function withDatabases(
  files: readonly string[],
  use: (databases: readonly SyncDatabase.Interface["db"][]) => Promise<void>,
) {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const contexts = yield* Effect.forEach(files, (file) => Layer.build(SyncDatabase.layerFromPath(file)))
        yield* Effect.promise(() => use(contexts.map((context) => Context.get(context, SyncDatabase.Service).db)))
      }),
    ),
  )
}

function memory() {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const adapter: SyncProvider.Adapter = {
    id: "memory",
    async list(prefix) {
      return {
        objects: [...values]
          .filter(([path]) => path.startsWith(prefix))
          .map(([path, value]) => ({ path, version: value.version, size: value.bytes.length })),
      }
    },
    async stat(path) {
      const value = values.get(path)
      return value ? { path, version: value.version, size: value.bytes.length } : undefined
    },
    async download(path, version) {
      const value = values.get(path)
      if (!value || (version && value.version !== version))
        throw new SyncProvider.ProviderError("memory", "download", "not-found", true)
      return { path, version: value.version, size: value.bytes.length, bytes: value.bytes.slice() }
    },
    async uploadAtomic(path, bytes, precondition) {
      const value = values.get(path)
      if (precondition.type === "absent" && value)
        throw new SyncProvider.ProviderError("memory", "upload", "conflict", false)
      const version = String(++revision)
      values.set(path, { version, bytes: bytes.slice() })
      return { path, version, size: bytes.length }
    },
    async deleteBatch(objects) {
      for (const object of objects) values.delete(object.path)
      return objects.map((object) => ({ path: object.path, status: "deleted" as const }))
    },
  }
  return { adapter, paths: () => [...values.keys()].sort() }
}
