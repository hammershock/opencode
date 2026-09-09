export * as SyncControlLog from "./control-log"

import { createHash } from "node:crypto"
import { Effect, Schema } from "effect"
import { sql } from "drizzle-orm"
import { NonNegativeInt, PositiveInt } from "../schema"
import { SyncDatabase } from "./database"
import { SyncEvent } from "./event"
import { SyncProvider } from "./provider"
import { SyncRuntime } from "./runtime"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const DeviceJoin = Schema.Struct({
  kind: Schema.Literal("device.join"),
  deviceID: SyncEvent.DeviceID,
  installationID: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
})
export type DeviceJoin = typeof DeviceJoin.Type

export const DeviceRename = Schema.Struct({
  kind: Schema.Literal("device.rename"),
  deviceID: SyncEvent.DeviceID,
  name: Schema.NonEmptyString,
})
export type DeviceRename = typeof DeviceRename.Type

export const DeviceRevoke = Schema.Struct({
  kind: Schema.Literal("device.revoke"),
  deviceID: SyncEvent.DeviceID,
})
export type DeviceRevoke = typeof DeviceRevoke.Type

export const SessionDelete = Schema.Struct({
  kind: Schema.Literal("session.delete"),
  tombstone: SyncEvent.Tombstone,
  requiredDevices: Schema.Array(SyncEvent.DeviceID),
  membershipDigest: Schema.NonEmptyString,
})
export type SessionDelete = typeof SessionDelete.Type

export const SessionAck = Schema.Struct({
  kind: Schema.Literal("session.ack"),
  tombstoneID: Schema.NonEmptyString,
  sessionID: Schema.NonEmptyString,
  deleteGeneration: PositiveInt,
  deviceID: SyncEvent.DeviceID,
  headGeneration: NonNegativeInt,
  headRevision: PositiveInt,
  headDigest: Schema.NonEmptyString,
})
export type SessionAck = typeof SessionAck.Type

export const SessionGC = Schema.Struct({
  kind: Schema.Literal("session.gc"),
  tombstoneID: Schema.NonEmptyString,
  sessionID: Schema.NonEmptyString,
  deleteGeneration: PositiveInt,
  acknowledgementsDigest: Schema.NonEmptyString,
})
export type SessionGC = typeof SessionGC.Type

export const Operation = Schema.Union([DeviceJoin, DeviceRename, DeviceRevoke, SessionDelete, SessionAck, SessionGC])
export type Operation = typeof Operation.Type

export const Intent = Schema.Struct({
  version: Schema.Literal(2),
  operationID: Schema.NonEmptyString,
  actorDeviceID: SyncEvent.DeviceID,
  createdAt: NonNegativeInt,
  operation: Operation,
})
export type Intent = typeof Intent.Type

export const Entry = Schema.Struct({
  version: Schema.Literal(2),
  generation: PositiveInt,
  previousDigest: Schema.NonEmptyString,
  operationID: Schema.NonEmptyString,
  actorDeviceID: SyncEvent.DeviceID,
  createdAt: NonNegativeInt,
  operation: Operation,
  digest: Schema.NonEmptyString,
})
export type Entry = typeof Entry.Type

export type Cursor = {
  readonly generation: number
  readonly digest: string
}

export type Member = {
  readonly deviceID: SyncEvent.DeviceID
  readonly installationID: string
  readonly name: string
  readonly joinGeneration: number
  readonly revisionGeneration: number
  readonly revokedGeneration?: number
}

export type Membership = {
  readonly generation: number
  readonly digest: string
  readonly devices: readonly SyncEvent.DeviceID[]
}

export interface Interface {
  readonly enqueue: (intent: Intent) => Promise<void>
  readonly append: (signal?: AbortSignal) => Promise<Entry | undefined>
  readonly drain: (limit?: number, signal?: AbortSignal) => Promise<readonly Entry[]>
  readonly replay: (signal?: AbortSignal) => Promise<Cursor>
  readonly cursor: () => Promise<Cursor>
  readonly entries: (afterGeneration?: number) => Promise<readonly Entry[]>
  readonly members: () => Promise<readonly Member[]>
  readonly membership: () => Promise<Membership>
  readonly sessionDelete: (tombstone: SyncEvent.Tombstone) => Promise<SessionDelete>
  readonly deletionEntries: () => Promise<readonly Entry[]>
  readonly acknowledgements: (tombstoneID: string) => Promise<readonly SessionAck[]>
  readonly prepareAcknowledgement: (
    acknowledgement: Omit<SessionAck, "headRevision">,
    head: unknown,
  ) => Promise<SessionAck>
  readonly ensureFence: (acknowledgement: SessionAck, signal?: AbortSignal) => Promise<void>
  readonly sessionGC: (deletion: Entry, signal?: AbortSignal) => Promise<SessionGC | undefined>
}

type CursorRow = { generation: number; digest: string }
type PayloadRow = { payload: string }
type MemberRow = {
  device_id: string
  installation_id: string
  name: string
  join_generation: number
  revision_generation: number
  revoked_generation: number | null
}
type AckRow = { payload: string }
type HeadRow = { revision: number; digest: string; payload: string }

export const GENESIS_DIGEST = digest("opencode-sync-control-v2")

class OperationValidationError extends Error {
  override readonly name = "SyncControlLog.OperationValidationError"
}

export function make(input: {
  readonly provider: SyncProvider.Adapter
  readonly db: SyncDatabase.Interface["db"]
  readonly spaceID: string
  readonly now?: () => number
}): Interface {
  const now = input.now ?? Date.now

  const cursor = async (): Promise<Cursor> =>
    (await Effect.runPromise(
      input.db.get<CursorRow>(sql`
        SELECT generation, digest FROM sync_control_cursor WHERE space_id = ${input.spaceID}
      `),
    )) ?? { generation: 0, digest: GENESIS_DIGEST }

  const members = async (): Promise<readonly Member[]> =>
    (
      await Effect.runPromise(
        input.db.all<MemberRow>(sql`
          SELECT device_id, installation_id, name, join_generation, revision_generation, revoked_generation
          FROM sync_device_member WHERE space_id = ${input.spaceID} ORDER BY device_id
        `),
      )
    ).map((row) => ({
      deviceID: SyncEvent.DeviceID.make(row.device_id),
      installationID: row.installation_id,
      name: row.name,
      joinGeneration: row.join_generation,
      revisionGeneration: row.revision_generation,
      ...(row.revoked_generation === null ? {} : { revokedGeneration: row.revoked_generation }),
    }))

  const membership = async (): Promise<Membership> => {
    const state = await cursor()
    const devices = (await members())
      .filter((member) => member.revokedGeneration === undefined)
      .map((member) => member.deviceID)
    return { generation: state.generation, digest: membershipDigest(devices), devices }
  }

  const sessionDelete = async (tombstone: SyncEvent.Tombstone): Promise<SessionDelete> => {
    const snapshot = await membership()
    return SessionDelete.make({
      kind: "session.delete",
      tombstone,
      requiredDevices: [...snapshot.devices],
      membershipDigest: snapshot.digest,
    })
  }

  const deletionEntries = async () => {
    const result = new Map<string, Entry>()
    for (const entry of await entries()) {
      if (entry.operation.kind !== "session.delete") continue
      if (!result.has(entry.operation.tombstone.sessionID)) result.set(entry.operation.tombstone.sessionID, entry)
    }
    return [...result.values()]
  }

  const acknowledgements = async (tombstoneID: string): Promise<readonly SessionAck[]> =>
    (
      await Effect.runPromise(
        input.db.all<AckRow>(sql`
          SELECT payload FROM sync_deletion_ack
          WHERE space_id = ${input.spaceID} AND tombstone_id = ${tombstoneID}
            AND committed_at IS NOT NULL
          ORDER BY device_id
        `),
      )
    ).map((row) => Schema.decodeUnknownSync(SessionAck)(JSON.parse(row.payload)))

  const prepareAcknowledgement = async (
    value: Omit<SessionAck, "headRevision">,
    head: unknown,
  ): Promise<SessionAck> => {
    const headPayload = canonical(head)
    if (digest(headPayload) !== value.headDigest) throw new Error("Head checkpoint digest does not match its payload")
    return Effect.runPromise(
      input.db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const existing = yield* tx.get<AckRow>(sql`
              SELECT payload FROM sync_deletion_ack
              WHERE space_id = ${input.spaceID} AND tombstone_id = ${value.tombstoneID}
                AND device_id = ${value.deviceID}
            `)
            if (existing) {
              const prepared = Schema.decodeUnknownSync(SessionAck)(JSON.parse(existing.payload))
              if (
                prepared.tombstoneID !== value.tombstoneID ||
                prepared.sessionID !== value.sessionID ||
                prepared.deleteGeneration !== value.deleteGeneration ||
                prepared.deviceID !== value.deviceID
              )
                return yield* Effect.die(
                  new Error(`Prepared deletion acknowledgement ${value.tombstoneID}/${value.deviceID} is divergent`),
                )
              return prepared
            }
            const stored = yield* tx.get<HeadRow>(sql`
              SELECT revision, digest, payload FROM sync_head_outbox
              WHERE space_id = ${input.spaceID} AND device_id = ${value.deviceID} AND digest = ${value.headDigest}
            `)
            const revision =
              stored?.revision ??
              (yield* tx.get<{ value: number }>(sql`
                SELECT COALESCE(MAX(revision), 0) + 1 AS value FROM sync_head_outbox
                WHERE space_id = ${input.spaceID} AND device_id = ${value.deviceID}
              `))?.value ??
              1
            if (stored && (stored.digest !== value.headDigest || stored.payload !== headPayload))
              return yield* Effect.die(new Error(`Head checkpoint ${value.headDigest} is divergent`))
            if (!stored)
              yield* tx.run(sql`
                INSERT INTO sync_head_outbox
                  (space_id, device_id, revision, digest, payload, created_at, committed_at)
                VALUES (
                  ${input.spaceID}, ${value.deviceID}, ${revision}, ${value.headDigest}, ${headPayload}, ${now()}, NULL
                )
              `)
            const acknowledgement = SessionAck.make({ ...value, headRevision: revision })
            yield* tx.run(sql`
              INSERT INTO sync_deletion_ack
                (space_id, tombstone_id, device_id, payload, created_at, committed_at, gc_generation)
              VALUES (
                ${input.spaceID}, ${value.tombstoneID}, ${value.deviceID}, ${canonical(acknowledgement)},
                ${now()}, NULL, NULL
              )
            `)
            return acknowledgement
          }),
        { behavior: "immediate" },
      ),
    )
  }

  const ensureFence = async (acknowledgement: SessionAck, signal?: AbortSignal) => {
    const path = fencePath(acknowledgement.tombstoneID, acknowledgement.deviceID)
    const stored = await Effect.runPromise(
      input.db.get<HeadRow>(sql`
        SELECT revision, digest, payload FROM sync_head_outbox
        WHERE space_id = ${input.spaceID} AND device_id = ${acknowledgement.deviceID}
          AND revision = ${acknowledgement.headRevision}
      `),
    )
    if (!stored || stored.digest !== acknowledgement.headDigest)
      throw new Error(`Missing prepared head checkpoint ${acknowledgement.headRevision}`)
    const checkpoint = {
      version: 2,
      acknowledgement,
      head: JSON.parse(stored.payload),
    }
    validateCheckpoint(checkpoint)
    const bytes = encoder.encode(canonical(checkpoint))
    try {
      await input.provider.uploadAtomic(path, bytes, { type: "absent" }, signal)
    } catch (cause) {
      if (!(cause instanceof SyncProvider.ProviderError) || (cause.kind !== "conflict" && cause.outcome !== "unknown"))
        throw cause
    }
    let verified = false
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const object = await input.provider.stat(path, signal)
        if (object) {
          const downloaded = await input.provider.download(path, object.version, signal)
          const existing = JSON.parse(decoder.decode(downloaded.bytes))
          validateCheckpoint(existing)
          if (canonical(existing) !== canonical(checkpoint))
            throw new Error(`Deletion fence ${acknowledgement.tombstoneID}/${acknowledgement.deviceID} is divergent`)
          verified = true
          break
        }
      } catch (cause) {
        if (!(cause instanceof SyncProvider.ProviderError) || !cause.retryable) throw cause
      }
      signal?.throwIfAborted()
      await Bun.sleep(25 * 2 ** attempt)
    }
    if (!verified) throw new SyncProvider.ProviderError(input.provider.id, "stat", "not-found", true, "unknown")
    await Effect.runPromise(
      input.db.run(sql`
        UPDATE sync_head_outbox SET committed_at = COALESCE(committed_at, ${now()})
        WHERE space_id = ${input.spaceID} AND device_id = ${acknowledgement.deviceID}
          AND revision = ${acknowledgement.headRevision} AND digest = ${acknowledgement.headDigest}
      `),
    )
  }

  const sessionGC = async (deletion: Entry, signal?: AbortSignal): Promise<SessionGC | undefined> => {
    if (deletion.operation.kind !== "session.delete") throw new Error("Session GC requires a deletion entry")
    const operation = deletion.operation
    const acked = await acknowledgements(operation.tombstone.id)
    const byDevice = new Map(acked.map((ack) => [String(ack.deviceID), ack]))
    const memberByDevice = new Map((await members()).map((member) => [String(member.deviceID), member]))
    const complete = operation.requiredDevices.every(
      (deviceID) =>
        byDevice.has(String(deviceID)) || memberByDevice.get(String(deviceID))?.revokedGeneration !== undefined,
    )
    if (!complete) return undefined
    for (const acknowledgement of acked) {
      signal?.throwIfAborted()
      const path = fencePath(acknowledgement.tombstoneID, acknowledgement.deviceID)
      const object = await input.provider.stat(path, signal)
      if (!object) return undefined
      const downloaded = await input.provider.download(path, object.version, signal)
      const fence = JSON.parse(decoder.decode(downloaded.bytes))
      validateCheckpoint(fence)
      if (canonical(fence.acknowledgement) !== canonical(acknowledgement))
        throw new Error(`Deletion fence ${acknowledgement.tombstoneID}/${acknowledgement.deviceID} is divergent`)
    }
    return SessionGC.make({
      kind: "session.gc",
      tombstoneID: operation.tombstone.id,
      sessionID: operation.tombstone.sessionID,
      deleteGeneration: deletion.generation,
      acknowledgementsDigest: acknowledgementDigest(operation.requiredDevices, byDevice, memberByDevice),
    })
  }

  const enqueue = async (value: Intent) => {
    const intent = normalizeIntent(Schema.decodeUnknownSync(Intent)(value))
    const payload = canonical(intent)
    await Effect.runPromise(
      input.db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const existing = yield* tx.get<PayloadRow>(sql`
              SELECT payload FROM sync_control_outbox
              WHERE space_id = ${input.spaceID} AND operation_id = ${intent.operationID}
            `)
            if (existing?.payload !== undefined) {
              const recorded = Schema.decodeUnknownSync(Intent)(JSON.parse(existing.payload))
              // createdAt is diagnostic metadata, not part of operation
              // identity. A process may crash after durably queuing an intent
              // and reconstruct it on restart; keep the first timestamp while
              // requiring the actor and operation to remain byte-for-byte
              // canonical.
              if (
                recorded.actorDeviceID !== intent.actorDeviceID ||
                canonical(recorded.operation) !== canonical(intent.operation)
              )
                return yield* Effect.die(new Error(`Control operation ${intent.operationID} has divergent payload`))
              return undefined
            }
            yield* tx.run(sql`
              INSERT OR IGNORE INTO sync_control_outbox
                (space_id, operation_id, payload, created_at, committed_generation)
              VALUES (${input.spaceID}, ${intent.operationID}, ${payload}, ${intent.createdAt}, NULL)
            `)
            return undefined
          }),
        { behavior: "immediate" },
      ),
    )
  }

  const commit = async (entry: Entry) => {
    await Effect.runPromise(
      input.db.transaction(
        (tx) =>
          Effect.gen(function* () {
            const current = (yield* tx.get<CursorRow>(sql`
                SELECT generation, digest FROM sync_control_cursor WHERE space_id = ${input.spaceID}
              `)) ?? { generation: 0, digest: GENESIS_DIGEST }
            if (current.generation >= entry.generation) {
              const stored = yield* tx.get<{ digest: string }>(sql`
                SELECT digest FROM sync_control_entry
                WHERE space_id = ${input.spaceID} AND generation = ${entry.generation}
              `)
              if (stored?.digest !== entry.digest)
                return yield* Effect.die(new Error(`Control generation ${entry.generation} is divergent`))
              return undefined
            }
            if (entry.generation !== current.generation + 1 || entry.previousDigest !== current.digest)
              return yield* Effect.die(
                new Error(`Control generation ${entry.generation} does not extend the local chain`),
              )
            yield* validateOperation(tx, input.spaceID, entry)
            yield* applyMembership(tx, input.spaceID, entry)
            yield* tx.run(sql`
              INSERT INTO sync_control_entry (space_id, generation, digest, payload, applied_at)
              VALUES (${input.spaceID}, ${entry.generation}, ${entry.digest}, ${canonical(entry)}, ${now()})
            `)
            yield* tx.run(sql`
              INSERT INTO sync_control_cursor (space_id, generation, digest)
              VALUES (${input.spaceID}, ${entry.generation}, ${entry.digest})
              ON CONFLICT(space_id) DO UPDATE SET generation = excluded.generation, digest = excluded.digest
            `)
            yield* tx.run(sql`
              UPDATE sync_control_outbox SET committed_generation = ${entry.generation}
              WHERE space_id = ${input.spaceID} AND operation_id = ${entry.operationID}
            `)
            return undefined
          }),
        { behavior: "immediate" },
      ),
    )
  }

  const read = async (generation: number, signal?: AbortSignal): Promise<Entry | undefined> => {
    signal?.throwIfAborted()
    const path = entryPath(generation)
    const object = await input.provider.stat(path, signal)
    if (!object) return undefined
    const downloaded = await input.provider.download(path, object.version, signal)
    const entry = decode(downloaded.bytes)
    validateEntry(entry, generation)
    return entry
  }

  const readEventually = async (generation: number, signal?: AbortSignal): Promise<Entry | undefined> => {
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const entry = await read(generation, signal)
        if (entry) return entry
      } catch (cause) {
        if (!(cause instanceof SyncProvider.ProviderError) || !cause.retryable) throw cause
      }
      signal?.throwIfAborted()
      await Bun.sleep(25 * 2 ** attempt)
    }
    return undefined
  }

  const replay = async (signal?: AbortSignal) => {
    while (true) {
      const state = await cursor()
      const entry = await read(state.generation + 1, signal)
      if (!entry) return state
      await commit(entry)
    }
  }

  const append = async (signal?: AbortSignal): Promise<Entry | undefined> => {
    await replay(signal)
    const pending = await Effect.runPromise(
      input.db.get<PayloadRow>(sql`
        SELECT payload FROM sync_control_outbox
        WHERE space_id = ${input.spaceID} AND committed_generation IS NULL
        ORDER BY created_at, operation_id LIMIT 1
      `),
    )
    if (!pending) return undefined
    const intent = Schema.decodeUnknownSync(Intent)(JSON.parse(pending.payload))
    const deletionIntent = intent.operation.kind === "session.delete" ? intent.operation : undefined
    const gcIntent = intent.operation.kind === "session.gc" ? intent.operation : undefined
    const resolveDeletionAlias = async () => {
      if (!deletionIntent) return undefined
      const existing = (await deletionEntries()).find(
        (entry) =>
          entry.operation.kind === "session.delete" &&
          entry.operation.tombstone.sessionID === deletionIntent.tombstone.sessionID,
      )
      if (existing) {
        await Effect.runPromise(
          input.db.run(sql`
            UPDATE sync_control_outbox SET committed_generation = ${existing.generation}
            WHERE space_id = ${input.spaceID} AND operation_id = ${intent.operationID}
          `),
        )
        return existing
      }
      return undefined
    }
    const alias = await resolveDeletionAlias()
    if (alias) return alias
    for (let attempt = 0; attempt < 32; attempt++) {
      signal?.throwIfAborted()
      const alias = await resolveDeletionAlias()
      if (alias) return alias
      const state = await cursor()
      // The membership fence belongs to the slot immediately before the
      // deletion, not to the moment the local intent was queued. If a join or
      // revoke wins a contended slot, rebasing recomputes the derived fence
      // while preserving the stable deletion operation ID and tombstone.
      let candidate: Intent = intent
      if (deletionIntent) candidate = { ...intent, operation: await sessionDelete(deletionIntent.tombstone) }
      if (gcIntent) {
        const deletion = (await entries()).find((entry) => entry.generation === gcIntent.deleteGeneration)
        if (!deletion) throw new Error(`Missing deletion generation ${gcIntent.deleteGeneration}`)
        const operation = await sessionGC(deletion)
        // GC must never publish a stale/incomplete acknowledgement set or
        // block later delete/revoke/ack facts. It is derived state, so a
        // no-longer-eligible prepared row is dropped and deterministically
        // recreated after the exact fences become readable again.
        if (!operation) {
          await Effect.runPromise(
            input.db.run(sql`
              DELETE FROM sync_control_outbox
              WHERE space_id = ${input.spaceID} AND operation_id = ${intent.operationID}
            `),
          )
          return append(signal)
        }
        candidate = { ...intent, operation }
      }
      const entry = createEntry(candidate, state.generation + 1, state.digest)
      try {
        const stable = await Effect.runPromise(
          input.db.transaction(
            (tx) =>
              Effect.gen(function* () {
                const current = (yield* tx.get<CursorRow>(sql`
                  SELECT generation, digest FROM sync_control_cursor WHERE space_id = ${input.spaceID}
                `)) ?? { generation: 0, digest: GENESIS_DIGEST }
                if (current.generation !== state.generation || current.digest !== state.digest) return false
                yield* validateOperation(tx, input.spaceID, entry)
                return true
              }),
            { behavior: "immediate" },
          ),
        )
        if (!stable) continue
      } catch (cause) {
        if (!(cause instanceof OperationValidationError)) throw cause
        // A locally invalid intent must never occupy the next immutable cloud
        // slot. Quarantine it so a revoked/stale process cannot poison the
        // entire append-only chain for every device.
        await Effect.runPromise(
          input.db.run(sql`
            UPDATE sync_control_outbox SET committed_generation = 0
            WHERE space_id = ${input.spaceID} AND operation_id = ${intent.operationID}
          `),
        )
        throw cause
      }
      const bytes = encoder.encode(canonical(entry))
      try {
        await input.provider.uploadAtomic(entryPath(entry.generation), bytes, { type: "absent" }, signal)
      } catch (cause) {
        if (!(cause instanceof SyncProvider.ProviderError)) throw cause
        if (cause.kind !== "conflict" && cause.outcome !== "unknown") throw cause
        const winner = await readEventually(entry.generation, signal)
        if (!winner) throw cause
        await commit(winner)
        if (winner.operationID === entry.operationID) return winner
        continue
      }
      const winner = await readEventually(entry.generation, signal)
      if (!winner) throw new SyncProvider.ProviderError(input.provider.id, "upload", "not-found", true, "unknown")
      await commit(winner)
      if (winner.operationID === entry.operationID) return winner
    }
    throw new Error(`Control operation ${intent.operationID} did not converge after repeated slot contention`)
  }

  const drain = async (limit = 64, signal?: AbortSignal) => {
    const committed: Entry[] = []
    for (let index = 0; index < limit; index++) {
      const entry = await append(signal)
      if (!entry) break
      committed.push(entry)
    }
    return committed
  }

  const entries = async (afterGeneration = 0) =>
    (
      await Effect.runPromise(
        input.db.all<PayloadRow>(sql`
          SELECT payload FROM sync_control_entry
          WHERE space_id = ${input.spaceID} AND generation > ${afterGeneration}
          ORDER BY generation
        `),
      )
    ).map((row) => Schema.decodeUnknownSync(Entry)(JSON.parse(row.payload)))

  return {
    enqueue,
    append,
    drain,
    replay,
    cursor,
    entries,
    members,
    membership,
    sessionDelete,
    deletionEntries,
    acknowledgements,
    prepareAcknowledgement,
    ensureFence,
    sessionGC,
  }
}

function createEntry(intent: Intent, generation: number, previousDigest: string): Entry {
  const value = {
    ...intent,
    generation,
    previousDigest,
  }
  return Entry.make({ ...value, digest: digest(canonical(value)) })
}

function validateEntry(entry: Entry, generation: number) {
  if (entry.generation !== generation)
    throw new Error(`Control slot ${generation} contains generation ${entry.generation}`)
  const value = {
    version: entry.version,
    operationID: entry.operationID,
    actorDeviceID: entry.actorDeviceID,
    createdAt: entry.createdAt,
    operation: entry.operation,
    generation: entry.generation,
    previousDigest: entry.previousDigest,
  }
  if (digest(canonical(value)) !== entry.digest)
    throw new Error(`Control generation ${generation} has an invalid digest`)
  if (canonical(normalizeIntent(value)) !== canonical(value))
    throw new Error(`Control generation ${generation} is not canonical`)
}

function validateOperation(tx: SyncEventStoreTransaction, spaceID: string, entry: Entry) {
  return Effect.gen(function* () {
    const operation = entry.operation
    const actor = yield* tx.get<MemberRow>(sql`
      SELECT device_id, installation_id, name, join_generation, revision_generation, revoked_generation
      FROM sync_device_member WHERE space_id = ${spaceID} AND device_id = ${entry.actorDeviceID}
    `)
    if (operation.kind === "device.join") {
      if (entry.actorDeviceID !== operation.deviceID)
        return yield* Effect.fail(new OperationValidationError("A device can only join itself"))
      if (actor && actor.installation_id !== operation.installationID)
        return yield* Effect.fail(
          new OperationValidationError(`Sync device ${operation.deviceID} has a cloned installation identity`),
        )
      return undefined
    }
    if (!actor || actor.revoked_generation !== null)
      return yield* Effect.fail(
        new OperationValidationError(`Control actor ${entry.actorDeviceID} is not an active member`),
      )
    if (operation.kind === "device.rename") {
      const target = yield* tx.get<MemberRow>(sql`
        SELECT device_id, installation_id, name, join_generation, revision_generation, revoked_generation
        FROM sync_device_member WHERE space_id = ${spaceID} AND device_id = ${operation.deviceID}
      `)
      if (!target || target.revoked_generation !== null)
        return yield* Effect.fail(new OperationValidationError(`Cannot rename inactive device ${operation.deviceID}`))
      return undefined
    }
    if (operation.kind === "device.revoke") {
      if (operation.deviceID === entry.actorDeviceID)
        return yield* Effect.fail(new OperationValidationError("The current control actor cannot revoke itself"))
      const target = yield* tx.get<MemberRow>(sql`
        SELECT device_id, installation_id, name, join_generation, revision_generation, revoked_generation
        FROM sync_device_member WHERE space_id = ${spaceID} AND device_id = ${operation.deviceID}
      `)
      if (!target)
        return yield* Effect.fail(new OperationValidationError(`Cannot revoke unknown device ${operation.deviceID}`))
      return undefined
    }
    if (operation.kind === "session.delete") {
      const rows = yield* tx.all<{ device_id: string }>(sql`
        SELECT device_id FROM sync_device_member
        WHERE space_id = ${spaceID} AND revoked_generation IS NULL ORDER BY device_id
      `)
      const required = rows.map((row) => SyncEvent.DeviceID.make(row.device_id))
      if (
        canonical(required) !== canonical(operation.requiredDevices) ||
        membershipDigest(required) !== operation.membershipDigest
      )
        return yield* Effect.fail(
          new OperationValidationError(`Deletion ${operation.tombstone.id} has an invalid membership fence`),
        )
      return undefined
    }
    if (operation.kind === "session.ack") {
      if (entry.actorDeviceID !== operation.deviceID)
        return yield* Effect.fail(new OperationValidationError("A device can only acknowledge a deletion for itself"))
      const deletionRow = yield* tx.get<PayloadRow>(sql`
        SELECT payload FROM sync_control_entry
        WHERE space_id = ${spaceID} AND generation = ${operation.deleteGeneration}
      `)
      if (!deletionRow)
        return yield* Effect.fail(
          new OperationValidationError(`Missing deletion generation ${operation.deleteGeneration}`),
        )
      const deletion = Schema.decodeUnknownSync(Entry)(JSON.parse(deletionRow.payload))
      if (
        deletion.operation.kind !== "session.delete" ||
        deletion.operation.tombstone.id !== operation.tombstoneID ||
        deletion.operation.tombstone.sessionID !== operation.sessionID ||
        !deletion.operation.requiredDevices.includes(operation.deviceID)
      )
        return yield* Effect.fail(
          new OperationValidationError(`Deletion acknowledgement ${entry.operationID} has an invalid fence`),
        )
      const existing = yield* tx.get<AckRow>(sql`
        SELECT payload FROM sync_deletion_ack
        WHERE space_id = ${spaceID} AND tombstone_id = ${operation.tombstoneID}
          AND device_id = ${operation.deviceID}
      `)
      if (existing && existing.payload !== canonical(operation))
        return yield* Effect.fail(
          new OperationValidationError(`Deletion acknowledgement ${entry.operationID} is divergent`),
        )
      return undefined
    }
    if (operation.kind === "session.gc") {
      const deletionRow = yield* tx.get<PayloadRow>(sql`
        SELECT payload FROM sync_control_entry
        WHERE space_id = ${spaceID} AND generation = ${operation.deleteGeneration}
      `)
      if (!deletionRow)
        return yield* Effect.fail(
          new OperationValidationError(`Missing deletion generation ${operation.deleteGeneration}`),
        )
      const deletion = Schema.decodeUnknownSync(Entry)(JSON.parse(deletionRow.payload))
      if (
        deletion.operation.kind !== "session.delete" ||
        deletion.operation.tombstone.id !== operation.tombstoneID ||
        deletion.operation.tombstone.sessionID !== operation.sessionID
      )
        return yield* Effect.fail(
          new OperationValidationError(`Session GC ${entry.operationID} has an invalid deletion fence`),
        )
      const ackRows = yield* tx.all<AckRow>(sql`
        SELECT payload FROM sync_deletion_ack
        WHERE space_id = ${spaceID} AND tombstone_id = ${operation.tombstoneID}
        ORDER BY device_id
      `)
      const acked = ackRows.map((row) => Schema.decodeUnknownSync(SessionAck)(JSON.parse(row.payload)))
      const byDevice = new Map(acked.map((ack) => [String(ack.deviceID), ack]))
      const memberRows = yield* tx.all<MemberRow>(sql`
        SELECT device_id, installation_id, name, join_generation, revision_generation, revoked_generation
        FROM sync_device_member WHERE space_id = ${spaceID} ORDER BY device_id
      `)
      const memberByDevice = new Map(memberRows.map((member) => [member.device_id, member]))
      const complete = deletion.operation.requiredDevices.every((deviceID) => {
        const member = memberByDevice.get(String(deviceID))
        return byDevice.has(String(deviceID)) || (member !== undefined && member.revoked_generation !== null)
      })
      if (
        !complete ||
        acknowledgementDigest(deletion.operation.requiredDevices, byDevice, memberByDevice) !==
          operation.acknowledgementsDigest
      )
        return yield* Effect.fail(
          new OperationValidationError(`Session GC ${entry.operationID} is not fully acknowledged`),
        )
    }
    return undefined
  })
}

type SyncEventStoreTransaction = Parameters<Parameters<SyncDatabase.Interface["db"]["transaction"]>[0]>[0]

function applyMembership(tx: SyncEventStoreTransaction, spaceID: string, entry: Entry) {
  const operation = entry.operation
  if (operation.kind === "device.join")
    return tx.run(sql`
      INSERT INTO sync_device_member
        (space_id, device_id, installation_id, name, join_generation, revision_generation, revoked_generation)
      VALUES (
        ${spaceID}, ${operation.deviceID}, ${operation.installationID}, ${operation.name},
        ${entry.generation}, ${entry.generation}, NULL
      )
      ON CONFLICT(space_id, device_id) DO NOTHING
    `)
  if (operation.kind === "device.rename")
    return tx.run(sql`
      UPDATE sync_device_member SET name = ${operation.name}, revision_generation = ${entry.generation}
      WHERE space_id = ${spaceID} AND device_id = ${operation.deviceID} AND revoked_generation IS NULL
    `)
  if (operation.kind === "device.revoke")
    return tx.run(sql`
      UPDATE sync_device_member
      SET revision_generation = ${entry.generation},
          revoked_generation = COALESCE(revoked_generation, ${entry.generation})
      WHERE space_id = ${spaceID} AND device_id = ${operation.deviceID}
    `)
  if (operation.kind === "session.ack")
    return Effect.gen(function* () {
      yield* tx.run(sql`
        INSERT INTO sync_deletion_ack
          (space_id, tombstone_id, device_id, payload, created_at, committed_at, gc_generation)
        VALUES (
          ${spaceID}, ${operation.tombstoneID}, ${operation.deviceID}, ${canonical(operation)},
          ${entry.createdAt}, ${entry.createdAt}, NULL
        )
        ON CONFLICT(space_id, tombstone_id, device_id) DO NOTHING
      `)
      yield* tx.run(sql`
        UPDATE sync_deletion_ack SET committed_at = COALESCE(committed_at, ${entry.createdAt})
        WHERE space_id = ${spaceID} AND tombstone_id = ${operation.tombstoneID}
          AND device_id = ${operation.deviceID} AND payload = ${canonical(operation)}
      `)
    })
  if (operation.kind === "session.gc")
    return tx.run(sql`
      UPDATE sync_deletion_ack SET gc_generation = ${entry.generation}
      WHERE space_id = ${spaceID} AND tombstone_id = ${operation.tombstoneID}
    `)
  return Effect.void
}

function normalizeIntent<T extends Intent | Omit<Entry, "digest">>(value: T): T {
  if (value.operation.kind !== "session.delete") return value
  return {
    ...value,
    operation: {
      ...value.operation,
      requiredDevices: [...new Set(value.operation.requiredDevices)].toSorted((left, right) =>
        String(left).localeCompare(String(right)),
      ),
    },
  }
}

function membershipDigest(devices: readonly SyncEvent.DeviceID[]) {
  return digest(canonical([...devices].map(String).toSorted((left, right) => left.localeCompare(right))))
}

function acknowledgementDigest(
  requiredDevices: readonly SyncEvent.DeviceID[],
  acknowledgements: ReadonlyMap<string, SessionAck>,
  members: ReadonlyMap<string, Member | MemberRow>,
) {
  return digest(
    canonical(
      [...requiredDevices]
        .map((deviceID) => {
          const id = String(deviceID)
          const acknowledgement = acknowledgements.get(id)
          if (acknowledgement) return { deviceID: id, acknowledgement }
          const member = members.get(id)
          const revokedGeneration = !member
            ? undefined
            : "revoked_generation" in member
              ? (member.revoked_generation ?? undefined)
              : member.revokedGeneration
          return { deviceID: id, revokedGeneration }
        })
        .toSorted((left, right) => left.deviceID.localeCompare(right.deviceID)),
    ),
  )
}

function entryPath(generation: number) {
  if (!Number.isSafeInteger(generation) || generation <= 0) throw new Error("Invalid control generation")
  return SyncProvider.objectPath(`control/v2/log/${String(generation).padStart(20, "0")}.json`)
}

function fencePath(tombstoneID: string, deviceID: SyncEvent.DeviceID) {
  validateID(tombstoneID)
  validateID(String(deviceID))
  return SyncProvider.objectPath(`control/v2/deletions/${tombstoneID}/fences/${deviceID}.json`)
}

function validateCheckpoint(
  value: unknown,
): asserts value is { version: 2; acknowledgement: SessionAck; head: Record<string, unknown> } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid deletion checkpoint")
  const checkpoint = value as Record<string, unknown>
  if (
    checkpoint.version !== 2 ||
    !checkpoint.head ||
    typeof checkpoint.head !== "object" ||
    Array.isArray(checkpoint.head)
  )
    throw new Error("Invalid deletion checkpoint")
  const acknowledgement = Schema.decodeUnknownSync(SessionAck)(checkpoint.acknowledgement)
  const head = Schema.decodeUnknownSync(SyncRuntime.Head)(checkpoint.head)
  if (
    head.deviceID !== acknowledgement.deviceID ||
    head.generation !== acknowledgement.headGeneration ||
    digest(canonical(head)) !== acknowledgement.headDigest ||
    !Array.isArray(head.metadata) ||
    head.metadata.some(
      (item) =>
        Boolean(item) &&
        typeof item === "object" &&
        !Array.isArray(item) &&
        (item as Record<string, unknown>).sessionID === acknowledgement.sessionID,
    )
  )
    throw new Error(`Deletion checkpoint ${acknowledgement.tombstoneID} does not prove Session absence`)
}

function validateID(value: string) {
  if (!value || !/^[A-Za-z0-9:_-]+$/.test(value)) throw new Error("Invalid control identity")
}

function decode(bytes: Uint8Array) {
  return Schema.decodeUnknownSync(Entry)(JSON.parse(decoder.decode(bytes)))
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value)
    if (encoded === undefined) throw new Error("Control values must be JSON serializable")
    return encoded
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`
}
