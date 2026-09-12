export * as SyncControl from "./control"

import { Context, Effect, Layer, Schedule, Schema, Semaphore } from "effect"
import { and, eq, sql } from "drizzle-orm"
import { Auth } from "../auth"
import { makeGlobalNode } from "../effect/app-node"
import { Database } from "../database/database"
import { SessionTable } from "../session/sql"
import { SessionV2 } from "../session"
import { EventV2 } from "../event"
import { BaiduSyncProvider } from "./baidu-provider"
import { BaiduCredential } from "./baidu-credential"
import { SyncSecureStore } from "./secure-store"
import { SyncSetup } from "./setup"
import { SyncEvent } from "./event"
import { SyncEventStore } from "./event-store"
import { SyncRuntime } from "./runtime"
import { SessionSync } from "./session"
import { SyncMetadata } from "./metadata"
import { SyncDevice } from "./device"
import { SyncScheduler } from "./scheduler"
import { SyncDatabase } from "./database"
import { NonNegativeInt } from "../schema"
import { SyncCrypto } from "./crypto"
import { SyncAttachment } from "./attachment"
import { SyncOwnership } from "./ownership"
import { SyncCodec } from "./codec"
import { SyncMembership } from "./membership"
import { SyncProvider } from "./provider"
import { SyncState } from "./state"
import { SyncTransfer } from "./transfer"
import { TargetBindingRegistry } from "../target-binding-registry"
import { TargetRegistry } from "../target-registry"
import { SessionActivity } from "../session/activity"
import { SessionLocationMutation } from "../session/location-mutation"
import { SyncTransferEvent } from "@opencode-ai/schema/sync-transfer-event"
import { SyncInitializationEvent } from "@opencode-ai/schema/sync-initialization-event"
import { SyncRoot } from "./root"
import { SyncControlLog } from "./control-log"

export const Status = Schema.Struct({
  configured: Schema.Boolean,
  initialized: Schema.Boolean,
  authenticated: Schema.Boolean,
  enabled: Schema.Boolean,
  locked: Schema.Boolean,
  provider: Schema.optional(Schema.String),
  namespaceID: Schema.optional(Schema.String),
  deviceID: Schema.optional(Schema.String),
  account: Schema.optional(SyncState.Account),
  activeSpace: Schema.optional(
    Schema.Struct({
      namespaceID: Schema.NonEmptyString,
      name: Schema.NonEmptyString,
      encryption: Schema.Literals(["none", "aes-256-gcm"]),
    }),
  ),
  intervalSeconds: Schema.optional(SyncState.IntervalSeconds),
  outbox: NonNegativeInt,
  cursors: Schema.Record(Schema.String, NonNegativeInt),
  lastSuccessAt: Schema.optional(NonNegativeInt),
  error: Schema.optional(Schema.String),
  diagnostic: Schema.optional(SyncRuntime.Diagnostic),
})
export type Status = typeof Status.Type
export const DeviceUpdate = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.NonEmptyString),
  revoke: Schema.optional(Schema.Boolean),
})
export const Recovery = Schema.Struct({ recoveryString: Schema.NonEmptyString })
export const HydrateInput = Schema.Struct({ sessionID: Schema.NonEmptyString })
export const DeleteSessionInput = Schema.Struct({ sessionID: Schema.NonEmptyString })
export const HydrateResult = Schema.Struct({
  sessionID: Schema.NonEmptyString,
  availability: SyncMetadata.Availability,
})
export const SwitchInput = Schema.Struct({
  namespaceID: Schema.NonEmptyString,
  force: Schema.optional(Schema.Boolean),
})
export const SwitchResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("switched"), namespaceID: Schema.NonEmptyString }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    reason: Schema.Literal("pending-outbox"),
    outbox: NonNegativeInt,
    error: Schema.optional(Schema.String),
  }),
])
export const AssignInput = Schema.Struct({ sessionIDs: Schema.Array(Schema.NonEmptyString) })

export class ControlError extends Schema.TaggedErrorClass<ControlError>()("SyncControlError", {
  kind: Schema.Literals([
    "unconfigured",
    "remote-uninitialized",
    "incompatible-remote",
    "locked",
    "provider",
    "storage",
    "invalid",
    "pending",
    "deleted",
  ]),
  diagnostic: Schema.optional(SyncRuntime.Diagnostic),
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Status, ControlError>
  readonly now: () => Effect.Effect<void, ControlError>
  readonly cloudStatus: () => Effect.Effect<SyncRoot.Inspection, ControlError>
  readonly initializeCloud: () => Effect.Effect<readonly string[], ControlError>
  readonly joinCurrentCloud: () => Effect.Effect<readonly string[], ControlError>
  readonly clearCloud: () => Effect.Effect<void, ControlError>
  readonly enable: (enabled: boolean) => Effect.Effect<void, ControlError>
  readonly setInterval: (seconds: SyncState.IntervalSeconds) => Effect.Effect<void, ControlError>
  readonly switchSpace: (input: typeof SwitchInput.Type) => Effect.Effect<typeof SwitchResult.Type, ControlError>
  readonly leaveSpace: (namespaceID: string) => Effect.Effect<readonly string[], ControlError>
  readonly deleteSpace: (namespaceID: string) => Effect.Effect<readonly string[], ControlError>
  readonly removeFromDevice: () => Effect.Effect<readonly string[], ControlError>
  readonly assignUnassigned: (input: typeof AssignInput.Type) => Effect.Effect<readonly string[], ControlError>
  readonly unassigned: () => Effect.Effect<readonly string[], ControlError>
  readonly logout: () => Effect.Effect<void, ControlError>
  readonly switchAccount: (input: SyncSetup.CompleteInput) => Effect.Effect<SyncState.State, ControlError>
  readonly join: (input: SyncSetup.JoinInput) => Effect.Effect<SyncState.State, SyncSetup.SetupError>
  readonly devices: () => Effect.Effect<SyncDevice.State, ControlError>
  readonly updateDevice: (input: typeof DeviceUpdate.Type) => Effect.Effect<SyncDevice.State, ControlError>
  readonly exportKey: () => Effect.Effect<typeof Recovery.Type, ControlError>
  /** Index remote heads without downloading their complete Session histories. */
  readonly sessions: () => Effect.Effect<readonly SyncMetadata.Item[], ControlError>
  /** Hydrates the selected metadata-only Session before it is opened locally. */
  readonly hydrate: (input: typeof HydrateInput.Type) => Effect.Effect<typeof HydrateResult.Type, ControlError>
  /** Deletes a synchronized Session even when only its cloud metadata exists locally. */
  readonly deleteSession: (input: typeof DeleteSessionInput.Type) => Effect.Effect<void, ControlError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SyncControl") {}

export type LayerOptions = {
  readonly credentialStore: () => Promise<BaiduCredential.Store>
  readonly secureStore?: () => Promise<SyncSecureStore.Store>
  readonly provider?: (input: {
    readonly store: BaiduCredential.Store
    readonly deviceID: string
    readonly remoteRoot: string
  }) => SyncProvider.Adapter
}

export const layerWith = (input: LayerOptions) => Layer.effect(Service, make(input))

const make = (input: LayerOptions) =>
  Effect.gen(function* () {
    const setup = yield* SyncSetup.Service
    const eventStore = yield* SyncEventStore.Service
    const events = yield* EventV2.Service
    const metadataStore = yield* SyncMetadata.Service
    const syncDB = (yield* SyncDatabase.Service).db
    const ownership = yield* SyncOwnership.Service
    const membership = yield* SyncMembership.Service
    const sessionDB = (yield* Database.Service).db
    const targetBindings = yield* TargetBindingRegistry.Service
    const targetRegistry = yield* TargetRegistry.Service
    const activity = yield* SessionActivity.Service
    const locationMutation = yield* SessionLocationMutation.Service
    let lastSuccessAt: number | undefined
    let lastDiagnostic: SyncRuntime.Diagnostic | undefined
    let engine: ReturnType<typeof SyncRuntime.make> | undefined
    let controlPlane:
      | {
          readonly log: SyncControlLog.Interface
          readonly synchronize: (drain: boolean, signal?: AbortSignal) => Promise<boolean>
          readonly enqueueDeletion: (tombstone: SyncEvent.Tombstone, signal?: AbortSignal) => Promise<void>
          readonly acknowledgeHead: (fence: SyncRuntime.HeadFence | undefined, signal?: AbortSignal) => Promise<void>
        }
      | undefined
    const currentControlPlane = () => controlPlane
    let engineIdentity: string | undefined
    let enginePrimed = false
    let scheduler: ReturnType<typeof SyncScheduler.make> | undefined
    const automaticOwner = `automatic:${process.pid}:${crypto.randomUUID()}`
    let automaticSpaceID: string | undefined
    let automaticConfigIdentity: string | undefined
    let automaticAbort: AbortController | undefined
    let fenceHeartbeat: ReturnType<typeof globalThis.setInterval> | undefined
    let fenceAbort: AbortController | undefined
    let fenceSpaceID: string | undefined
    let lastMaintenanceAt = 0
    let lastRemoteProbeAt = 0
    const lifecycleSemaphore = yield* Semaphore.make(1)
    const lifecycle = <A, E, R>(effect: Effect.Effect<A, E, R>) => lifecycleSemaphore.withPermits(1)(effect)

    type RunRequestRow = {
      status: "pending" | "running" | "succeeded" | "failed"
      diagnostic: string | null
    }
    const enqueueRunRequest = (spaceID: string, requestID: string, requestedAt: number) =>
      syncDB.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
              DELETE FROM sync_run_request
              WHERE space_id = ${spaceID} AND status <> 'pending' AND completed_at < ${requestedAt - 86_400_000}
            `)
            yield* tx.run(sql`
              INSERT INTO sync_run_request
                (space_id, request_id, requested_at, status, completed_at, diagnostic)
              VALUES (${spaceID}, ${requestID}, ${requestedAt}, 'pending', NULL, NULL)
            `)
          }),
        { behavior: "immediate" },
      )
    const claimRunRequests = (spaceID: string, runID: string, owner: string, claimedAt: number) =>
      syncDB.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
              UPDATE sync_run_request
              SET status = 'pending', run_id = NULL, claim_owner = NULL, claimed_at = NULL
              WHERE space_id = ${spaceID} AND status = 'running'
                AND claimed_at <= ${claimedAt - AUTOMATIC_LEASE_TTL}
            `)
            const rows = yield* tx.all<{ request_id: string }>(sql`
              SELECT request_id FROM sync_run_request
              WHERE space_id = ${spaceID} AND status = 'pending'
              ORDER BY requested_at, request_id
            `)
            const requestIDs = rows.map((row) => row.request_id)
            if (!requestIDs.length) return requestIDs
            yield* tx.run(sql`
              UPDATE sync_run_request
              SET status = 'running', run_id = ${runID}, claim_owner = ${owner}, claimed_at = ${claimedAt}
              WHERE space_id = ${spaceID} AND status = 'pending'
                AND request_id IN (SELECT value FROM json_each(${JSON.stringify(requestIDs)}))
            `)
            return requestIDs
          }),
        { behavior: "immediate" },
      )
    const finishRunRequests = (
      spaceID: string,
      runID: string,
      owner: string,
      status: "succeeded" | "failed",
      diagnostic?: SyncRuntime.Diagnostic,
    ) => {
      const completedAt = Date.now()
      return syncDB.transaction(
        (tx) =>
          Effect.gen(function* () {
            yield* tx.run(sql`
              UPDATE sync_event_lease SET expires_at = ${completedAt + AUTOMATIC_LEASE_TTL}
              WHERE name = ${`${spaceID}:automatic`} AND owner = ${owner} AND expires_at > ${completedAt}
            `)
            const lease = yield* tx.get<{ owner: string }>(sql`
              SELECT owner FROM sync_event_lease
              WHERE name = ${`${spaceID}:automatic`} AND owner = ${owner}
                AND expires_at = ${completedAt + AUTOMATIC_LEASE_TTL}
            `)
            if (!lease) return false
            yield* tx.run(sql`
              UPDATE sync_run_request
              SET status = ${status}, completed_at = ${completedAt},
                  diagnostic = ${diagnostic ? JSON.stringify(diagnostic) : null}
              WHERE space_id = ${spaceID} AND status = 'running'
                AND run_id = ${runID} AND claim_owner = ${owner}
            `)
            return true
          }),
        { behavior: "immediate" },
      )
    }

    const clearSpace = (namespaceID: string) =>
      SyncDatabase.purgeSpace(syncDB, namespaceID).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const purgeSpace = Effect.fn("SyncControl.purgeSpace")(function* (namespaceID: string) {
      const sessions = yield* membership
        .unassignSpace(namespaceID)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* clearSpace(namespaceID)
      return sessions
    })
    const ensureMembershipBootstrap = Effect.fn("SyncControl.ensureMembershipBootstrap")(function* (
      namespaceID: string,
    ) {
      const completed = yield* syncDB
        .get<{ value: number }>(
          sql`
          SELECT 1 AS value FROM sync_membership_bootstrap WHERE space_id = ${namespaceID}
        `,
        )
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (completed) return [] as readonly string[]
      const sessions = yield* membership
        .assignAll(namespaceID)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* syncDB
        .run(
          sql`
          INSERT OR IGNORE INTO sync_membership_bootstrap (space_id, completed_at)
          VALUES (${namespaceID}, ${Date.now()})
        `,
        )
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      return sessions
    })
    yield* setup.state().pipe(
      Effect.flatMap((state) =>
        membership.stale(new Set(state?.spaces.map((item) => item.descriptor.namespaceID) ?? [])),
      ),
      Effect.flatMap((stale) => Effect.forEach(stale, purgeSpace, { discard: true })),
      Effect.catch(() =>
        Effect.sync(() => {
          // Sync recovery must never make the local application unavailable.
          lastDiagnostic = SyncRuntime.diagnostic("pull", new Error("storage"))
        }),
      ),
    )

    const load = Effect.fn("SyncControl.load")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config || !SyncRoot.isAccountScope(config.namespaceID))
        return yield* new ControlError({ kind: "unconfigured" })
      const store = eventStore.scope(config.namespaceID)
      const state = yield* setup.state().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      const joinedAt = state?.spaces.find((item) => item.descriptor.namespaceID === config.namespaceID)?.joinedAt
      if (joinedAt !== undefined)
        yield* store
          .requeueAcknowledgedBefore(SyncEvent.DeviceID.make(config.deviceID), joinedAt)
          .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      const metadata = metadataStore.scope(config.namespaceID)
      const identity = activeIdentity(config)
      if (engine && engineIdentity === identity) return engine
      const credentials = yield* Effect.tryPromise({
        try: input.credentialStore,
        catch: () => new ControlError({ kind: "locked" }),
      })
      const credential = yield* Effect.tryPromise({
        try: () => BaiduSyncProvider.readCredential(credentials, config.deviceID),
        catch: () => new ControlError({ kind: "locked" }),
      })
      if (!credential) return yield* new ControlError({ kind: "locked" })
      const codec =
        config.encryption === "none"
          ? SyncCodec.plaintext()
          : yield* Effect.tryPromise({
              try: () => (input.secureStore ?? SyncSecureStore.detect)(),
              catch: () => new ControlError({ kind: "locked" }),
            }).pipe(Effect.flatMap((secure) => codecFor(config, secure)))
      const provider = input.provider
        ? input.provider({ store: credentials, deviceID: config.deviceID, remoteRoot: config.remoteRoot })
        : BaiduSyncProvider.adapter({ store: credentials, deviceID: config.deviceID, root: config.remoteRoot })
      const transfer = SyncTransfer.make((progress) =>
        Effect.runPromise(events.publish(SyncTransferEvent.Updated, { progress })).then(() => undefined),
      )
      const attachment = SyncAttachment.make({ codec, namespaceID: config.namespaceID, provider, transfer })
      const sessionProjector = (deviceID: SyncEvent.DeviceID) =>
        SessionSync.projector(
          events,
          deviceID,
          ({ sessionID }) => metadata.availability(sessionID, "conflict"),
          attachment,
          (sessionID) =>
            sessionDB
              .delete(SessionTable)
              .where(eq(SessionTable.id, SessionV2.ID.make(sessionID)))
              .run()
              .pipe(Effect.andThen(metadata.remove(sessionID)), Effect.asVoid),
          config.namespaceID,
          (sessionID, spaceID) => ownership.assign(sessionID, spaceID),
          activity,
          locationMutation,
        )
      const log = SyncControlLog.make({ provider, db: syncDB, spaceID: config.namespaceID })
      const projectControl = async (signal?: AbortSignal) => {
        const projected =
          (
            await Effect.runPromise(
              syncDB.get<{ generation: number }>(sql`
                SELECT generation FROM sync_control_projection WHERE space_id = ${config.namespaceID}
              `),
            )
          )?.generation ?? 0
        const entries = await log.entries(projected)
        for (const entry of entries) {
          signal?.throwIfAborted()
          if (entry.operation.kind === "session.delete")
            await Effect.runPromise(
              store.absorbDeletions([entry.operation.tombstone], sessionProjector(entry.actorDeviceID)),
            )
          // session.gc is a logical convergence fact. The compact local
          // tombstone remains durable so stale event segments can never revive
          // a deleted Session.
          await Effect.runPromise(
            syncDB.run(sql`
              INSERT INTO sync_control_projection (space_id, generation)
              VALUES (${config.namespaceID}, ${entry.generation})
              ON CONFLICT(space_id) DO UPDATE
              SET generation = MAX(sync_control_projection.generation, excluded.generation)
            `),
          )
        }
        return entries.length > 0
      }
      const ensureJoined = async (signal?: AbortSignal) => {
        await log.replay(signal)
        const current = (await log.members()).find((member) => member.deviceID === config.deviceID)
        if (current?.revokedGeneration !== undefined) throw new Error("This sync device has been revoked")
        if (!current) {
          await log.enqueue(
            SyncControlLog.Intent.make({
              version: 2,
              operationID: `device.join:${config.deviceID}`,
              actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
              createdAt: Date.now(),
              operation: SyncControlLog.DeviceJoin.make({
                kind: "device.join",
                deviceID: SyncEvent.DeviceID.make(config.deviceID),
                installationID: config.deviceID,
                name: config.deviceName,
              }),
            }),
          )
          await log.drain(16, signal)
        } else if (current.name !== config.deviceName) {
          await log.enqueue(
            SyncControlLog.Intent.make({
              version: 2,
              operationID: `device.rename:${config.deviceID}:${encodeURIComponent(config.deviceName)}`,
              actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
              createdAt: Date.now(),
              operation: SyncControlLog.DeviceRename.make({
                kind: "device.rename",
                deviceID: SyncEvent.DeviceID.make(config.deviceID),
                name: config.deviceName,
              }),
            }),
          )
          await log.drain(16, signal)
        }
      }
      const synchronizeControl = async (drain: boolean, signal?: AbortSignal) => {
        const before =
          (
            await Effect.runPromise(
              syncDB.get<{ generation: number }>(sql`
                SELECT generation FROM sync_control_projection WHERE space_id = ${config.namespaceID}
              `),
            )
          )?.generation ?? 0
        await ensureJoined(signal)
        if (drain) await log.drain(32, signal)
        // ensureJoined has already replayed every visible control entry and
        // drain rebases through replay before appending. A second replay only
        // probes the next nonexistent Baidu object on the steady-state path.
        await projectControl(signal)
        const after = (await log.cursor()).generation
        return after > before
      }
      const acknowledgeHead = async (fence: SyncRuntime.HeadFence | undefined, signal?: AbortSignal) => {
        if (!fence) return
        signal?.throwIfAborted()
        const projected =
          (
            await Effect.runPromise(
              syncDB.get<{ generation: number }>(sql`
                SELECT generation FROM sync_control_projection WHERE space_id = ${config.namespaceID}
              `),
            )
          )?.generation ?? 0
        const deletions = await log.deletionEntries()
        // Ordinary Session traffic has no deletion fence to acknowledge. Do
        // not probe and drain the append-only control log four times after
        // every head update when there is no deletion workflow at all.
        if (!deletions.length) return
        for (const deletion of deletions) {
          if (deletion.generation > projected || deletion.operation.kind !== "session.delete") continue
          const operation = deletion.operation
          if (!operation.requiredDevices.includes(SyncEvent.DeviceID.make(config.deviceID))) continue
          if (fence.sessionIDs.has(operation.tombstone.sessionID)) continue
          const acknowledged = await log.acknowledgements(operation.tombstone.id)
          if (acknowledged.some((item) => item.deviceID === config.deviceID)) continue
          const acknowledgement = await log.prepareAcknowledgement(
            {
              kind: "session.ack",
              tombstoneID: operation.tombstone.id,
              sessionID: operation.tombstone.sessionID,
              deleteGeneration: deletion.generation,
              deviceID: SyncEvent.DeviceID.make(config.deviceID),
              headGeneration: fence.generation,
              headDigest: fence.digest,
            },
            fence.head,
          )
          await log.ensureFence(acknowledgement, signal)
          await log.enqueue(
            SyncControlLog.Intent.make({
              version: 2,
              operationID: `session.ack:${operation.tombstone.id}:${config.deviceID}`,
              actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
              createdAt: Date.now(),
              operation: acknowledgement,
            }),
          )
        }
        await log.drain(64, signal)
        await log.replay(signal)
        await projectControl(signal)
        const entries = await log.entries()
        const collected = new Set(
          entries.flatMap((entry) => (entry.operation.kind === "session.gc" ? [entry.operation.deleteGeneration] : [])),
        )
        for (const deletion of await log.deletionEntries()) {
          if (deletion.operation.kind !== "session.delete" || collected.has(deletion.generation)) continue
          const operation = await log.sessionGC(deletion, signal)
          if (!operation) continue
          await log.enqueue(
            SyncControlLog.Intent.make({
              version: 2,
              operationID: `session.gc:${operation.tombstoneID}`,
              actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
              createdAt: Date.now(),
              operation,
            }),
          )
        }
        await log.drain(64, signal)
        await log.replay(signal)
        await projectControl(signal)
      }
      controlPlane = {
        log,
        synchronize: synchronizeControl,
        acknowledgeHead,
        enqueueDeletion: async (tombstone, signal) => {
          signal?.throwIfAborted()
          await log.enqueue(
            SyncControlLog.Intent.make({
              version: 2,
              operationID: tombstone.id,
              actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
              createdAt: tombstone.deletedAt,
              // The authoritative membership fence is recomputed when this
              // intent wins an immutable control generation. Keeping the local
              // enqueue independent of the network lets offline deletion be
              // durable immediately.
              operation: SyncControlLog.SessionDelete.make({
                kind: "session.delete",
                tombstone,
                requiredDevices: [],
                membershipDigest: "pending",
              }),
            }),
          )
        },
      }
      engine = SyncRuntime.make({
        config: {
          deviceID: SyncEvent.DeviceID.make(config.deviceID),
          deviceName: config.deviceName,
          enabled: true,
        },
        codec,
        provider,
        transfer,
        store,
        projector: sessionProjector,
        deletionMode: "control-log",
        attachment: {
          externalize: (event) => SessionSync.externalize(event, attachment),
          references: SyncAttachment.references,
          collect: attachment.collect,
        },
        metadata: () =>
          Effect.all([
            sessionDB.select().from(SessionTable).where(eq(SessionTable.sync_space_id, config.namespaceID)).all(),
            metadata.list(),
          ]).pipe(
            Effect.map(([rows, indexed]) => {
              const indexedBySession = new Map(indexed.map((item) => [item.sessionID, item]))
              return rows.map((row) => ({
                sessionID: row.id,
                title: row.title,
                ...portableTargetMetadata({
                  deviceID: config.deviceID,
                  deviceName: config.deviceName,
                  lastKnownTargetName: row.last_known_target_name ?? undefined,
                  indexed: indexedBySession.get(row.id),
                }),
                directory: row.directory,
                revision: row.time_updated,
                updatedAt: row.time_updated,
              }))
            }),
          ),
        metadataProjector: {
          apply: (values, deviceID) => metadata.apply(deviceID, values),
          retain: metadata.retain,
        },
        acknowledged: () =>
          syncDB
            .all<{ device_id: string; cursor: number }>(
              sql`
              SELECT device_id, cursor FROM sync_event_cursor WHERE space_id = ${config.namespaceID}
            `,
            )
            .pipe(Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.device_id, row.cursor])))),
        revoked: () =>
          Effect.promise(() => log.members()).pipe(
            Effect.map((members) =>
              members.filter((member) => member.revokedGeneration !== undefined).map((member) => member.deviceID),
            ),
          ),
        requiredDevices: () => Effect.promise(() => log.membership()).pipe(Effect.map((value) => value.devices)),
        deletionCollected: (sessionIDs) => Effect.forEach(sessionIDs, ownership.unassign, { discard: true }),
      })
      engineIdentity = identity
      enginePrimed = false
      return engine
    })

    const readStatus = Effect.fn("SyncControl.status")(function* () {
      const state = yield* setup.state().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const resolved = yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const config = resolved && SyncRoot.isAccountScope(resolved.namespaceID) ? resolved : undefined
      const outbox =
        (yield* syncDB.get<{ value: number }>(sql`
          SELECT COUNT(*) AS value FROM sync_event_outbox WHERE space_id = ${config?.namespaceID ?? "legacy"}
        `))?.value ?? 0
      const cursorRows = yield* syncDB.all<{ device_id: string; cursor: number }>(
        sql`SELECT device_id, cursor FROM sync_event_cursor WHERE space_id = ${config?.namespaceID ?? "legacy"}`,
      )
      return Status.make({
        configured: Boolean(config),
        initialized: Boolean(state),
        // Status is a local presentation path. Credential and encryption-key
        // availability are checked authoritatively when a cloud operation starts.
        authenticated: Boolean(state?.account),
        enabled: state?.enabled ?? false,
        locked: false,
        provider: state?.provider,
        namespaceID: config?.namespaceID,
        deviceID: state?.deviceID,
        account: state?.account,
        activeSpace: config
          ? { namespaceID: config.namespaceID, name: config.name, encryption: config.encryption }
          : undefined,
        intervalSeconds: state?.intervalSeconds,
        outbox,
        cursors: Object.fromEntries(cursorRows.map((row) => [row.device_id, row.cursor])),
        lastSuccessAt,
        error: lastDiagnostic?.message,
        diagnostic: lastDiagnostic,
      })
    })
    const status = () => readStatus().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const projectPortableTargets = (config: SyncState.Active) =>
      metadataStore
        .scope(config.namespaceID)
        .list()
        .pipe(
          Effect.flatMap((items) =>
            Effect.forEach(
              items.filter((item) => item.ownerDeviceID !== config.deviceID && item.targetLabel),
              (item) =>
                sessionDB
                  .update(SessionTable)
                  .set({ portable_target_label: item.targetLabel })
                  // Revision zero is the untouched cloud projection. A local
                  // force-rebind owns this device's execution Location and
                  // must not be overwritten by subsequent metadata probes.
                  .where(
                    and(eq(SessionTable.id, SessionV2.ID.make(item.sessionID)), eq(SessionTable.location_revision, 0)),
                  )
                  .run(),
              { discard: true },
            ),
          ),
          Effect.mapError(() => new ControlError({ kind: "storage" })),
        )
    const requireCloudReady = Effect.fn("SyncControl.requireCloudReady")(function* () {
      const cloud = yield* setup
        .cloudStatus()
        .pipe(Effect.mapError((error) => new ControlError({ kind: "provider", diagnostic: error.diagnostic })))
      if (cloud.status === "unavailable")
        return yield* new ControlError({
          kind: "provider",
          diagnostic: SyncRuntime.diagnostic(
            "pull",
            new SyncProvider.ProviderError(
              "baidu",
              "stat",
              "not-found",
              true,
              "failed",
              undefined,
              undefined,
              undefined,
              "control-pointer",
            ),
          ),
        })
      if (cloud.status === "uninitialized" || cloud.status === "replaced")
        return yield* new ControlError({ kind: "remote-uninitialized" })
      if (cloud.status === "incompatible" || cloud.status === "legacy-upgrade-required")
        return yield* new ControlError({ kind: "incompatible-remote" })
      const active = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      const expected = active ? SyncRoot.accountInstanceID(active.namespaceID) : undefined
      if (!expected || cloud.manifest.instanceID !== expected)
        return yield* new ControlError({ kind: "remote-uninitialized" })
    })
    const synchronize = Effect.fn("SyncControl.synchronize")(function* (input: {
      readonly active: SyncState.Active
      readonly runtime: ReturnType<typeof SyncRuntime.make>
      readonly signal?: AbortSignal
    }) {
      const plane = currentControlPlane()
      if (!plane) return yield* new ControlError({ kind: "storage" })
      yield* Effect.tryPromise({
        try: () => plane.synchronize(true, input.signal),
        catch: (cause) => new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("pull", cause) }),
      })
      yield* input.runtime.now(input.signal).pipe(
        Effect.mapError(() => {
          lastDiagnostic = input.runtime.status().lastError
          return new ControlError({ kind: "provider", diagnostic: lastDiagnostic })
        }),
      )
      yield* Effect.tryPromise({
        try: () => plane.acknowledgeHead(input.runtime.headFence(), input.signal),
        catch: (cause) => new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("head", cause) }),
      })
      yield* projectPortableTargets(input.active)
      lastSuccessAt = Date.now()
      lastDiagnostic = undefined
    })
    const synchronizeExclusive = Effect.fn("SyncControl.synchronizeExclusive")(function* (input: {
      readonly active: SyncState.Active
      readonly runtime: ReturnType<typeof SyncRuntime.make>
    }) {
      const store = eventStore.scope(input.active.namespaceID)
      const owner = `manual:${process.pid}:${crypto.randomUUID()}`
      const deadline = Date.now() + AUTOMATIC_LEASE_TTL + AUTOMATIC_LEASE_HEARTBEAT
      while (
        !(yield* store
          .acquire("automatic", owner, AUTOMATIC_LEASE_TTL)
          .pipe(Effect.mapError(() => new ControlError({ kind: "storage" }))))
      ) {
        if (Date.now() >= deadline) return yield* new ControlError({ kind: "pending" })
        yield* Effect.sleep("50 millis")
      }
      const controller = new AbortController()
      let renewing = false
      const heartbeat = globalThis.setInterval(() => {
        if (renewing) return
        renewing = true
        void Effect.runPromise(store.renew("automatic", owner, AUTOMATIC_LEASE_TTL))
          .then((active) => {
            if (!active) controller.abort(new Error("Manual sync lease expired"))
          })
          .catch((cause) => controller.abort(cause))
          .finally(() => (renewing = false))
      }, AUTOMATIC_LEASE_HEARTBEAT)
      yield* ensureMembershipBootstrap(input.active.namespaceID).pipe(
        Effect.andThen(synchronize({ ...input, signal: controller.signal })),
        Effect.andThen(
          store.renew("automatic", owner, AUTOMATIC_LEASE_TTL).pipe(
            Effect.mapError(() => new ControlError({ kind: "storage" })),
            Effect.flatMap((active) => (active ? Effect.void : Effect.fail(new ControlError({ kind: "storage" })))),
          ),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            globalThis.clearInterval(heartbeat)
            controller.abort(new Error("Manual sync completed"))
            yield* store.release("automatic", owner).pipe(Effect.catch(() => Effect.void))
          }),
        ),
      )
    })
    const now = Effect.fn("SyncControl.now")(function* () {
      const active = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!active || !SyncRoot.isAccountScope(active.namespaceID))
        return yield* new ControlError({ kind: "unconfigured" })
      if (!active.enabled) {
        yield* requireCloudReady()
        const runtime = yield* load()
        yield* synchronizeExclusive({ active, runtime })
        return
      }
      const requestID = crypto.randomUUID()
      const requestedAt = Date.now()
      yield* enqueueRunRequest(active.namespaceID, requestID, requestedAt).pipe(
        Effect.mapError(() => new ControlError({ kind: "storage" })),
      )
      void scheduler?.trigger().catch(() => undefined)
      const deadline = Date.now() + MANUAL_RUN_WAIT
      while (true) {
        const row = yield* syncDB
          .get<RunRequestRow>(
            sql`
            SELECT status, diagnostic FROM sync_run_request
            WHERE space_id = ${active.namespaceID} AND request_id = ${requestID}
          `,
          )
          .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
        if (row?.status === "succeeded") {
          yield* syncDB
            .run(
              sql`
              DELETE FROM sync_run_request
              WHERE space_id = ${active.namespaceID} AND request_id = ${requestID}
            `,
            )
            .pipe(Effect.catch(() => Effect.void))
          return
        }
        if (row?.status === "failed") {
          const diagnostic = row.diagnostic
            ? Schema.decodeUnknownSync(SyncRuntime.Diagnostic)(JSON.parse(row.diagnostic))
            : undefined
          return yield* new ControlError({ kind: "provider", diagnostic })
        }
        if (Date.now() >= deadline) return yield* new ControlError({ kind: "pending" })
        yield* Effect.sleep("100 millis")
      }
    })
    const automatic = Effect.fn("SyncControl.automatic")(function* (
      config: SyncState.Active,
      schedulerSignal: AbortSignal,
    ) {
      if (automaticConfigIdentity && automaticConfigIdentity !== activeIdentity(config))
        yield* releaseInactiveOwnership()
      const store = eventStore.scope(config.namespaceID)
      // Every TUI owns a server process, but provider work is device-scoped.
      // Keep one renewable leader so sibling processes only observe shared DB state.
      const claimed = yield* store
        .acquire("automatic", automaticOwner, AUTOMATIC_LEASE_TTL)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!claimed) return
      automaticSpaceID = config.namespaceID
      automaticConfigIdentity = activeIdentity(config)
      const renewed = yield* store
        .renew("automatic", automaticOwner, AUTOMATIC_LEASE_TTL)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!renewed) {
        automaticSpaceID = undefined
        automaticConfigIdentity = undefined
        return yield* new ControlError({ kind: "storage" })
      }
      const controller = new AbortController()
      automaticAbort = controller
      const abortFromScheduler = () => controller.abort(schedulerSignal.reason)
      if (schedulerSignal.aborted) abortFromScheduler()
      else schedulerSignal.addEventListener("abort", abortFromScheduler, { once: true })
      let renewing = false
      const heartbeat = globalThis.setInterval(() => {
        if (renewing) return
        renewing = true
        void Effect.runPromise(
          Effect.all([store.renew("automatic", automaticOwner, AUTOMATIC_LEASE_TTL), setup.config()]),
        )
          .then(([active, current]) => {
            if (!active || !current?.enabled || activeIdentity(current) !== activeIdentity(config))
              controller.abort(new Error("Automatic sync configuration changed"))
          })
          .catch((cause) => controller.abort(cause))
          .finally(() => (renewing = false))
      }, AUTOMATIC_LEASE_HEARTBEAT)
      yield* Effect.gen(function* () {
        yield* ensureMembershipBootstrap(config.namespaceID)
        const runID = crypto.randomUUID()
        const claimedRequests = yield* claimRunRequests(config.namespaceID, runID, automaticOwner, Date.now()).pipe(
          Effect.mapError(() => new ControlError({ kind: "storage" })),
        )
        if (claimedRequests.length) {
          const finishIfLeader = (status: "succeeded" | "failed", diagnostic?: SyncRuntime.Diagnostic) =>
            finishRunRequests(config.namespaceID, runID, automaticOwner, status, diagnostic).pipe(
              Effect.mapError(() => new ControlError({ kind: "storage" })),
              Effect.flatMap((active) => (active ? Effect.void : Effect.fail(new ControlError({ kind: "storage" })))),
            )
          yield* Effect.gen(function* () {
            const runtime = yield* load()
            yield* requireCloudReady()
            yield* synchronize({ active: config, runtime, signal: controller.signal })
          }).pipe(
            Effect.tap(() => finishIfLeader("succeeded")),
            Effect.tapError((error) =>
              finishIfLeader("failed", error.diagnostic ?? SyncRuntime.diagnostic("pull", error)).pipe(
                Effect.catch(() => Effect.void),
              ),
            ),
          )
          enginePrimed = true
          lastRemoteProbeAt = Date.now()
          return
        }
        const runtime = yield* load()
        if (!enginePrimed) {
          // A new process/leader and a recovered connection must observe the
          // manifest, deletion archive and remote checkpoints before it can
          // publish possibly stale offline outbox rows.
          yield* requireCloudReady()
          const plane = controlPlane
          if (!plane) return yield* new ControlError({ kind: "storage" })
          yield* Effect.tryPromise({
            try: () => plane.synchronize(true, controller.signal),
            catch: (cause) => new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("pull", cause) }),
          })
          yield* runtime.pull(controller.signal).pipe(
            Effect.andThen(runtime.hydrate(controller.signal)),
            Effect.mapError(() => {
              lastDiagnostic = runtime.status().lastError
              return new ControlError({ kind: "provider", diagnostic: lastDiagnostic })
            }),
          )
          yield* projectPortableTargets(config)
          enginePrimed = true
          lastRemoteProbeAt = Date.now()
        }
        let outboundError: ControlError | undefined
        const dirty = yield* store
          .dirty(SyncEvent.DeviceID.make(config.deviceID))
          .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
        const headPending = dirty
          ? false
          : yield* runtime.headPending().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
        // Outbound edits are latency-sensitive. Their immutable segment and
        // head can be published safely before the slower remote reconciliation.
        // Head-only acknowledgement/device changes use the same path even when
        // the event outbox is empty.
        if (dirty || headPending) {
          const plane = controlPlane
          if (!plane) return yield* new ControlError({ kind: "storage" })
          // A normal Session append has no control-plane dependency. The
          // leader was primed above and the independent remote probe observes
          // later membership/deletion facts. Replaying the control log before
          // every event upload adds two provider RTTs to the interactive path.
          yield* runtime.push(controller.signal).pipe(
            Effect.tap(() =>
              Effect.gen(function* () {
                yield* projectPortableTargets(config)
                lastSuccessAt = Date.now()
                lastDiagnostic = undefined
              }),
            ),
            Effect.catch(() =>
              Effect.sync(() => {
                lastDiagnostic = runtime.status().lastError
                enginePrimed = false
                outboundError = new ControlError({ kind: "provider", diagnostic: lastDiagnostic })
              }),
            ),
          )
          if (!outboundError)
            yield* Effect.tryPromise({
              try: () => plane.acknowledgeHead(runtime.headFence(), controller.signal),
              catch: (cause) =>
                new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("head", cause) }),
            })
        }
        const current = Date.now()
        const maintenance = current - lastMaintenanceAt >= schedulerInterval(config.intervalSeconds)
        if (current - lastRemoteProbeAt < REMOTE_PROBE_INTERVAL) {
          if (outboundError) return yield* outboundError
          return
        }
        lastRemoteProbeAt = current
        const plane = controlPlane
        if (!plane) return yield* new ControlError({ kind: "storage" })
        // Control entries and per-device heads are independent remote facts.
        // Probe them concurrently so Baidu latency is paid once per scheduler
        // tick instead of serially on the interactive receive path.
        const [controlChanged, headChanged] = yield* Effect.all(
          [
            Effect.tryPromise({
              try: () => plane.synchronize(false, controller.signal),
              catch: (cause) =>
                new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("pull", cause) }),
            }),
            runtime.probe(controller.signal).pipe(
              Effect.mapError(() => {
                lastDiagnostic = runtime.status().lastError
                enginePrimed = false
                return new ControlError({ kind: "provider", diagnostic: lastDiagnostic })
              }),
            ),
          ],
          { concurrency: "unbounded" },
        )
        const changed = controlChanged || headChanged
        if (changed) {
          yield* runtime.receive(controller.signal).pipe(
            Effect.andThen(runtime.hydrate(controller.signal)),
            Effect.andThen(runtime.push(controller.signal)),
            Effect.mapError(() => {
              lastDiagnostic = runtime.status().lastError
              enginePrimed = false
              return new ControlError({ kind: "provider", diagnostic: lastDiagnostic })
            }),
          )
          yield* Effect.tryPromise({
            try: () => plane.acknowledgeHead(runtime.headFence(), controller.signal),
            catch: (cause) => new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("head", cause) }),
          })
          yield* projectPortableTargets(config)
        } else if (maintenance) {
          // Maintenance stays inside the device-wide automatic lease. Running
          // it as a detached flight under a second lease allowed two provider
          // writers and let reset race an old maintenance upload.
          yield* requireCloudReady()
          yield* synchronize({ active: config, runtime, signal: controller.signal })
          lastMaintenanceAt = current
        }
        if (controller.signal.aborted) return yield* new ControlError({ kind: "storage" })
        if (outboundError) return yield* outboundError
        lastSuccessAt = Date.now()
        lastDiagnostic = undefined
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            globalThis.clearInterval(heartbeat)
            schedulerSignal.removeEventListener("abort", abortFromScheduler)
            if (automaticAbort === controller) automaticAbort = undefined
            if (!controller.signal.aborted) return
            yield* store.release("automatic", automaticOwner).pipe(Effect.catch(() => Effect.void))
            if (automaticSpaceID === config.namespaceID) {
              automaticSpaceID = undefined
              automaticConfigIdentity = undefined
            }
          }),
        ),
      )
    })
    const releaseInactiveOwnership = Effect.fn("SyncControl.releaseInactiveOwnership")(function* () {
      const spaceID = automaticSpaceID
      automaticSpaceID = undefined
      automaticConfigIdentity = undefined
      if (fenceHeartbeat) globalThis.clearInterval(fenceHeartbeat)
      fenceHeartbeat = undefined
      fenceAbort?.abort(new Error("Exclusive sync fence released"))
      fenceAbort = undefined
      fenceSpaceID = undefined
      engine = undefined
      controlPlane = undefined
      engineIdentity = undefined
      enginePrimed = false
      if (!spaceID) return
      const store = eventStore.scope(spaceID)
      yield* store.release("automatic", automaticOwner).pipe(Effect.catch(() => Effect.void))
    })
    const stopWorkers = Effect.fn("SyncControl.stopWorkers")(function* () {
      const currentScheduler = scheduler
      scheduler = undefined
      automaticAbort?.abort(new Error("Sync scheduler stopped"))
      yield* Effect.promise(() => currentScheduler?.stop() ?? Promise.resolve())
      yield* releaseInactiveOwnership()
    })
    const quiesceAutomatic = Effect.fn("SyncControl.quiesceAutomatic")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (config?.enabled)
        yield* setup.setEnabled(false).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* stopWorkers()
      // Cloud initialize/clear must also be fenced before a v2 account scope
      // exists (fresh setup and v1 migration). All local processes derive the
      // same fallback scope from the shared state, so lifecycle operations
      // remain serialized instead of rejecting their own preconditions.
      const fenceScope = config?.namespaceID || SETUP_FENCE_SCOPE
      const store = eventStore.scope(fenceScope)
      const deadline = Date.now() + AUTOMATIC_LEASE_TTL + AUTOMATIC_LEASE_HEARTBEAT
      while (
        !(yield* store
          .acquire("automatic", automaticOwner, AUTOMATIC_LEASE_TTL)
          .pipe(Effect.mapError(() => new ControlError({ kind: "storage" }))))
      ) {
        if (Date.now() >= deadline) return yield* new ControlError({ kind: "storage" })
        yield* Effect.sleep("50 millis")
      }
      automaticSpaceID = fenceScope
      fenceSpaceID = fenceScope
      const controller = new AbortController()
      fenceAbort = controller
      let renewing = false
      fenceHeartbeat = globalThis.setInterval(() => {
        if (renewing || controller.signal.aborted) return
        renewing = true
        void Effect.runPromise(store.renew("automatic", automaticOwner, AUTOMATIC_LEASE_TTL))
          .then((active) => {
            if (!active) controller.abort(new Error("Exclusive sync lease expired"))
          })
          .catch((cause) => controller.abort(cause))
          .finally(() => (renewing = false))
      }, AUTOMATIC_LEASE_HEARTBEAT)
      return config?.enabled ?? false
    })
    const assertExclusiveFence = Effect.fn("SyncControl.assertExclusiveFence")(function* () {
      const spaceID = fenceSpaceID
      const controller = fenceAbort
      if (!spaceID || !controller || controller.signal.aborted) return yield* new ControlError({ kind: "storage" })
      const active = yield* eventStore
        .scope(spaceID)
        .renew("automatic", automaticOwner, AUTOMATIC_LEASE_TTL)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!active) {
        controller.abort(new Error("Exclusive sync lease expired"))
        return yield* new ControlError({ kind: "storage" })
      }
      return controller.signal
    })
    const restartScheduler = Effect.fn("SyncControl.restartScheduler")(function* (config?: SyncState.Active) {
      yield* stopWorkers()
      if (!config?.enabled || !SyncRoot.isAccountScope(config.namespaceID)) return
      scheduler = SyncScheduler.make({
        intervalMs: AUTOMATIC_TICK_INTERVAL,
        maximumBackoffMs: AUTOMATIC_MAXIMUM_BACKOFF,
        run: (signal) =>
          Effect.runPromise(
            setup.config().pipe(
              Effect.mapError(() => new ControlError({ kind: "storage" })),
              Effect.flatMap((current) => {
                if (!current?.enabled || !SyncRoot.isAccountScope(current.namespaceID))
                  return releaseInactiveOwnership()
                return automatic(current, signal)
              }),
              Effect.tapError((error) =>
                Effect.gen(function* () {
                  if (error.kind === "remote-uninitialized") {
                    yield* events.publish(SyncInitializationEvent.Required, { trigger: "automatic" })
                  }
                  lastDiagnostic = error.diagnostic ?? SyncRuntime.diagnostic("pull", error)
                }),
              ),
            ),
          ),
      })
      scheduler.start()
    })
    const configured = yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined)))
    yield* restartScheduler(configured)
    const initialProjectionRevision =
      (yield* syncDB
        .get<{ value: number }>(
          sql`
            SELECT
              COALESCE((SELECT SUM(cursor) FROM sync_event_cursor), 0) +
              COALESCE((SELECT SUM(generation) FROM sync_event_head), 0) +
              (SELECT COUNT(*) FROM sync_local_operation) AS value
          `,
        )
        .pipe(Effect.orDie))?.value ?? 0
    let projectionRevision = initialProjectionRevision
    // Remote projection and same-device capture may commit in a sibling process.
    // A cheap shared-DB revision turns those commits back into this process's event stream.
    yield* syncDB
      .get<{ value: number }>(
        sql`
          SELECT
            COALESCE((SELECT SUM(cursor) FROM sync_event_cursor), 0) +
            COALESCE((SELECT SUM(generation) FROM sync_event_head), 0) +
            (SELECT COUNT(*) FROM sync_local_operation) AS value
        `,
      )
      .pipe(
        Effect.map((row) => row?.value ?? 0),
        Effect.flatMap((revision) => {
          if (revision === projectionRevision) return Effect.void
          projectionRevision = revision
          return events.publish(SyncTransferEvent.ProjectionUpdated, { revision })
        }),
        Effect.catch(() => Effect.void),
        Effect.repeat(Schedule.spaced(PROJECTION_POLL_INTERVAL)),
        Effect.forkScoped,
      )
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* stopWorkers()
      }),
    )
    const enable = Effect.fn("SyncControl.enable")(function* (enabled: boolean) {
      if (!enabled) {
        yield* quiesceAutomatic()
        engine = undefined
        yield* releaseInactiveOwnership()
        return
      }
      yield* setup.setEnabled(enabled).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      yield* restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
    })
    const cloudStatus = () =>
      setup
        .cloudStatus()
        .pipe(Effect.mapError((error) => new ControlError({ kind: "provider", diagnostic: error.diagnostic })))
    const initializeCloud = Effect.fn("SyncControl.initializeCloud")(function* () {
      yield* quiesceAutomatic()
      const initialized = yield* Effect.gen(function* () {
        const signal = yield* assertExclusiveFence()
        const state = yield* setup
          .initializeCloud(signal)
          .pipe(Effect.mapError((error) => new ControlError({ kind: "provider", diagnostic: error.diagnostic })))
        const active = SyncState.active(state)
        if (!active) return yield* new ControlError({ kind: "storage" })
        const sessions = yield* ensureMembershipBootstrap(active.namespaceID)
        yield* assertExclusiveFence()
        return { active, sessions }
      }).pipe(Effect.ensuring(releaseInactiveOwnership()))
      engine = undefined
      yield* restartScheduler(initialized.active)
      return initialized.sessions
    })
    const joinCurrentCloud = Effect.fn("SyncControl.joinCurrentCloud")(function* () {
      yield* quiesceAutomatic()
      const joined = yield* Effect.gen(function* () {
        const signal = yield* assertExclusiveFence()
        const state = yield* setup
          .joinCurrentCloud(signal)
          .pipe(Effect.mapError((error) => new ControlError({ kind: "provider", diagnostic: error.diagnostic })))
        yield* assertExclusiveFence()
        const active = SyncState.active(state)
        if (!active) return yield* new ControlError({ kind: "storage" })
        engine = undefined
        controlPlane = undefined
        const runtime = yield* load()
        const plane = currentControlPlane()
        if (!plane) return yield* new ControlError({ kind: "storage" })
        // Joining is remote-first. The exclusive device fence is held through
        // control replay, hydration and durable local membership bootstrap.
        yield* Effect.tryPromise({
          try: () => plane.synchronize(true, signal),
          catch: (cause) => new ControlError({ kind: "provider", diagnostic: SyncRuntime.diagnostic("pull", cause) }),
        })
        yield* runtime.pull(signal).pipe(
          Effect.andThen(runtime.hydrate(signal)),
          Effect.mapError(() => new ControlError({ kind: "provider", diagnostic: runtime.status().lastError })),
        )
        const sessions = yield* ensureMembershipBootstrap(active.namespaceID)
        yield* assertExclusiveFence()
        return { active, sessions }
      }).pipe(Effect.ensuring(releaseInactiveOwnership()))
      yield* restartScheduler(joined.active)
      return joined.sessions
    })
    const clearCloud = Effect.fn("SyncControl.clearCloud")(function* () {
      yield* quiesceAutomatic()
      yield* Effect.gen(function* () {
        const signal = yield* assertExclusiveFence()
        yield* setup
          .clearCloud(signal)
          .pipe(Effect.mapError((error) => new ControlError({ kind: "provider", diagnostic: error.diagnostic })))
        yield* assertExclusiveFence()
      }).pipe(Effect.ensuring(releaseInactiveOwnership()))
      engine = undefined
    })
    const setInterval = Effect.fn("SyncControl.setInterval")(function* (seconds: SyncState.IntervalSeconds) {
      yield* setup.setInterval(seconds).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
    })
    const pending = (namespaceID: string) =>
      syncDB
        .get<{ value: number }>(
          sql`
          SELECT COUNT(*) AS value FROM sync_event_outbox WHERE space_id = ${namespaceID}
        `,
        )
        .pipe(
          Effect.map((row) => row?.value ?? 0),
          Effect.mapError(() => new ControlError({ kind: "storage" })),
        )
    const switchSpace = Effect.fn("SyncControl.switchSpace")(function* (input: typeof SwitchInput.Type) {
      const current = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!current) {
        const authenticated = yield* setup
          .authenticated()
          .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
        if (!authenticated) return yield* new ControlError({ kind: "locked" })
        const resume = yield* quiesceAutomatic()
        yield* setup.activate(input.namespaceID).pipe(
          Effect.mapError(() => new ControlError({ kind: "invalid" })),
          Effect.ensuring(releaseInactiveOwnership()),
        )
        if (resume) yield* setup.setEnabled(true).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
        engine = undefined
        yield* restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
        return SwitchResult.make({ status: "switched", namespaceID: input.namespaceID })
      }
      if (current.namespaceID === input.namespaceID)
        return SwitchResult.make({ status: "switched", namespaceID: input.namespaceID })
      const blocked = yield* Effect.tryPromise({
        try: () =>
          flushBeforeSwitch({
            pending: () => Effect.runPromise(pending(current.namespaceID)),
            flush: () => Effect.runPromise(now()),
            force: input.force ?? false,
          }),
        catch: (cause) => (cause instanceof ControlError ? cause : new ControlError({ kind: "provider" })),
      })
      if (blocked) return SwitchResult.make(blocked)
      const resume = yield* quiesceAutomatic()
      yield* setup.activate(input.namespaceID).pipe(
        Effect.mapError(() => new ControlError({ kind: "invalid" })),
        Effect.ensuring(releaseInactiveOwnership()),
      )
      if (resume) yield* setup.setEnabled(true).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      yield* restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
      return SwitchResult.make({ status: "switched", namespaceID: input.namespaceID })
    })
    const deleteSpace = Effect.fn("SyncControl.deleteSpace")(function* (namespaceID: string) {
      const resume = yield* quiesceAutomatic()
      const deleted = yield* Effect.gen(function* () {
        const signal = yield* assertExclusiveFence()
        const result = yield* setup.deleteSpace(namespaceID, signal).pipe(
          Effect.mapError((error) =>
            error.kind === "invalid"
              ? new ControlError({ kind: "invalid" })
              : new ControlError({
                  kind: error.kind === "storage" ? "storage" : "provider",
                  diagnostic: error.diagnostic ?? SyncRuntime.diagnostic("delete", error),
                }),
          ),
        )
        yield* assertExclusiveFence()
        return result
      }).pipe(Effect.ensuring(releaseInactiveOwnership()))
      const sessions = yield* purgeSpace(deleted)
      if (resume && (yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))))
        yield* setup.setEnabled(true).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      yield* restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
      return sessions
    })
    const leaveSpace = Effect.fn("SyncControl.leaveSpace")(function* (namespaceID: string) {
      const resume = yield* quiesceAutomatic()
      yield* setup.leave(namespaceID).pipe(
        Effect.mapError(() => new ControlError({ kind: "storage" })),
        Effect.ensuring(releaseInactiveOwnership()),
      )
      const sessions = yield* purgeSpace(namespaceID)
      if (resume && (yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))))
        yield* setup.setEnabled(true).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      yield* restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
      return sessions
    })
    const removeFromDevice = Effect.fn("SyncControl.removeFromDevice")(function* () {
      yield* quiesceAutomatic()
      const spaces = yield* setup.removeFromDevice().pipe(
        Effect.mapError(() => new ControlError({ kind: "storage" })),
        Effect.ensuring(releaseInactiveOwnership()),
      )
      const sessions = yield* membership
        .unassignAll()
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* Effect.forEach(spaces, clearSpace, { discard: true })
      engine = undefined
      return sessions
    })
    const assignUnassigned = Effect.fn("SyncControl.assignUnassigned")(function* (input: typeof AssignInput.Type) {
      const current = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!current) return yield* new ControlError({ kind: "unconfigured" })
      return yield* membership
        .assignUnassigned(input.sessionIDs, current.namespaceID)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    })
    const unassigned = () => membership.unassigned().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const logout = Effect.fn("SyncControl.logout")(function* () {
      yield* quiesceAutomatic()
      yield* setup.logout().pipe(
        Effect.mapError(() => new ControlError({ kind: "storage" })),
        Effect.ensuring(releaseInactiveOwnership()),
      )
      engine = undefined
    })
    const switchAccount = Effect.fn("SyncControl.switchAccount")(function* (input: SyncSetup.CompleteInput) {
      yield* quiesceAutomatic()
      const state = yield* setup.switchAccount(input).pipe(
        Effect.mapError(() => new ControlError({ kind: "provider" })),
        Effect.ensuring(releaseInactiveOwnership()),
      )
      engine = undefined
      return state
    })
    const join = Effect.fn("SyncControl.join")(function* (input: SyncSetup.JoinInput) {
      const previous = yield* setup.config()
      const state = yield* setup.join(input)
      const active = SyncState.active(state)
      if (
        previous?.namespaceID === input.namespaceID &&
        previous.encryption === "aes-256-gcm" &&
        active?.namespaceID === input.namespaceID
      ) {
        engine = undefined
        yield* restartScheduler(active)
      }
      return state
    })
    const deviceState = Effect.fn("SyncControl.deviceState")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      yield* load()
      const plane = controlPlane
      if (!plane) return yield* new ControlError({ kind: "storage" })
      const members = yield* Effect.tryPromise({
        try: () => plane.log.members(),
        catch: () => new ControlError({ kind: "storage" }),
      })
      return SyncDevice.State.make({
        version: 1,
        devices: members.map((member) => ({
          id: member.deviceID,
          name: member.name,
          revision: member.revisionGeneration,
          updatedAt: member.revisionGeneration,
          revoked: member.revokedGeneration !== undefined,
        })),
      })
    })
    const updateDevice = Effect.fn("SyncControl.updateDevice")(function* (input: typeof DeviceUpdate.Type) {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      if (input.revoke) assertCanRevoke(config.deviceID, input.id)
      yield* load()
      const plane = controlPlane
      if (!plane) return yield* new ControlError({ kind: "storage" })
      yield* Effect.tryPromise({
        try: async () => {
          if (input.name)
            await plane.log.enqueue(
              SyncControlLog.Intent.make({
                version: 2,
                operationID: `device.rename:${input.id}:${encodeURIComponent(input.name)}`,
                actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
                createdAt: Date.now(),
                operation: SyncControlLog.DeviceRename.make({
                  kind: "device.rename",
                  deviceID: SyncEvent.DeviceID.make(input.id),
                  name: input.name,
                }),
              }),
            )
          if (input.revoke)
            await plane.log.enqueue(
              SyncControlLog.Intent.make({
                version: 2,
                operationID: `device.revoke:${input.id}`,
                actorDeviceID: SyncEvent.DeviceID.make(config.deviceID),
                createdAt: Date.now(),
                operation: SyncControlLog.DeviceRevoke.make({
                  kind: "device.revoke",
                  deviceID: SyncEvent.DeviceID.make(input.id),
                }),
              }),
            )
        },
        catch: () => new ControlError({ kind: "storage" }),
      })
      yield* now()
      if (input.name && input.id === config.deviceID)
        yield* setup.setDeviceName(input.name).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      return yield* deviceState()
    })
    const exportKey = Effect.fn("SyncControl.exportKey")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      if (config.encryption === "none") return yield* new ControlError({ kind: "invalid" })
      const secure = yield* Effect.tryPromise({
        try: () => SyncSecureStore.detect(),
        catch: () => new ControlError({ kind: "locked" }),
      })
      const encoded = yield* Effect.tryPromise({
        try: () => secure.get(`space:${config.namespaceID}:root`),
        catch: () => new ControlError({ kind: "locked" }),
      })
      if (!encoded) return yield* new ControlError({ kind: "locked" })
      return {
        recoveryString: yield* Effect.promise(() =>
          SyncCrypto.exportRecoveryString({
            namespaceID: config.namespaceID,
            rootKey: new Uint8Array(Buffer.from(encoded, "base64url")),
          }),
        ),
      }
    })
    const availabilityRaw = Effect.fn("SyncControl.sessionAvailability")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      const metadata = metadataStore.scope(config.namespaceID)
      const [indexed, local, bindingSnapshot, targetSnapshot] = yield* Effect.all([
        metadata.list(),
        sessionDB.select({ id: SessionTable.id }).from(SessionTable).all(),
        Effect.tryPromise({ try: () => targetBindings.load(), catch: () => new ControlError({ kind: "storage" }) }),
        Effect.tryPromise({ try: () => targetRegistry.load(), catch: () => new ControlError({ kind: "storage" }) }),
      ])
      const localIDs = new Set(local.map((item) => String(item.id)))
      return yield* Effect.forEach(indexed, (item) => {
        // A portable label is intentionally all that crosses devices. An
        // explicit binding wins; otherwise an exact local target name resolves
        // it without syncing either SSH configuration or target IDs.
        const next: SyncMetadata.Availability =
          item.availability === "conflict"
            ? "conflict"
            : item.ownerDeviceID === config.deviceID && localIDs.has(item.sessionID)
              ? "ready"
              : item.targetLabel &&
                  !portableTargetResolvable(item.targetLabel, bindingSnapshot.bindings, targetSnapshot.targets)
                ? "unresolved"
                : localIDs.has(item.sessionID)
                  ? "ready"
                  : item.availability === "hydrating" || item.availability === "partial"
                    ? item.availability
                    : "metadata-only"
        return next === item.availability
          ? Effect.succeed(item)
          : metadata.availability(item.sessionID, next).pipe(Effect.as({ ...item, availability: next }))
      })
    })
    const availability = () => availabilityRaw().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const sessions = Effect.fn("SyncControl.sessions")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      // Browsing is local and immediate. The sole device worker refreshes this
      // metadata on its fast probe; opening the panel never becomes a second
      // provider reader/writer in a sibling TUI.
      return yield* availability()
    })
    const hydrateRaw = Effect.fn("SyncControl.hydrate")(function* (input: typeof HydrateInput.Type) {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      const metadata = metadataStore.scope(config.namespaceID)
      const known = (yield* metadata.list().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))).find(
        (item) => item.sessionID === input.sessionID,
      )
      if (!known) return yield* new ControlError({ kind: "storage" })
      yield* metadata
        .availability(input.sessionID, "hydrating")
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      // Hydration is requested through the one device-wide worker. This keeps
      // Session projection fenced against clear/leave/remove in sibling TUIs.
      const result = yield* now().pipe(
        Effect.andThen(availability()),
        Effect.map((items) => items.find((item) => item.sessionID === input.sessionID)),
        Effect.catch((error) =>
          metadata.availability(input.sessionID, "partial").pipe(
            Effect.mapError(() => new ControlError({ kind: "storage" })),
            Effect.andThen(Effect.fail(error)),
          ),
        ),
      )
      lastSuccessAt = Date.now()
      lastDiagnostic = undefined
      return HydrateResult.make({ sessionID: input.sessionID, availability: result?.availability ?? "partial" })
    })
    const hydrate = (input: typeof HydrateInput.Type) => hydrateRaw(input)
    const deleteSession = Effect.fn("SyncControl.deleteSession")(function* (input: typeof DeleteSessionInput.Type) {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      const metadata = metadataStore.scope(config.namespaceID)
      const store = eventStore.scope(config.namespaceID)
      const known = yield* Effect.all([
        metadata.list(),
        store.deletions(),
        sessionDB
          .select({ id: SessionTable.id })
          .from(SessionTable)
          .where(eq(SessionTable.id, SessionV2.ID.make(input.sessionID)))
          .get(),
      ]).pipe(
        Effect.map(
          ([items, deletions, local]) =>
            Boolean(local) ||
            items.some((item) => item.sessionID === input.sessionID) ||
            deletions.some((item) => item.sessionID === input.sessionID),
        ),
        Effect.mapError(() => new ControlError({ kind: "storage" })),
      )
      if (!known) return yield* new ControlError({ kind: "invalid" })
      yield* load()
      const plane = controlPlane
      if (!plane) return yield* new ControlError({ kind: "storage" })
      const tombstone = SyncEvent.Tombstone.make({
        id: `sync-delete:${config.deviceID}:${crypto.randomUUID()}`,
        sessionID: input.sessionID,
        deletedAt: Date.now(),
      })
      // Queue the global remove-wins fact before applying the local deletion.
      // Both stores live in the same durable sync database; if the process dies
      // between these idempotent steps, control replay completes the deletion.
      yield* Effect.tryPromise({
        try: () => plane.enqueueDeletion(tombstone),
        catch: () => new ControlError({ kind: "storage" }),
      })
      yield* store.delete(tombstone).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* metadata.remove(input.sessionID).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      // Provider work is owned by the single automatic leader for this device.
      // Another TUI may initiate the deletion, but it only commits local
      // durable intents; the leader observes the shared DB and publishes them
      // on its next one-second tick. This avoids concurrent Baidu writers from
      // sibling TUI processes while preserving the 15-second convergence SLA.
    })
    return {
      status,
      now: () => lifecycle(now()),
      cloudStatus,
      initializeCloud: () => lifecycle(initializeCloud()),
      joinCurrentCloud: () => lifecycle(joinCurrentCloud()),
      clearCloud: () => lifecycle(clearCloud()),
      enable: (value: boolean) => lifecycle(enable(value)),
      setInterval: (value: SyncState.IntervalSeconds) => lifecycle(setInterval(value)),
      switchSpace: (value: typeof SwitchInput.Type) => lifecycle(switchSpace(value)),
      leaveSpace: (value: string) => lifecycle(leaveSpace(value)),
      deleteSpace: (value: string) => lifecycle(deleteSpace(value)),
      removeFromDevice: () => lifecycle(removeFromDevice()),
      assignUnassigned,
      unassigned,
      logout: () => lifecycle(logout()),
      switchAccount: (value: SyncSetup.CompleteInput) => lifecycle(switchAccount(value)),
      join: (value: SyncSetup.JoinInput) => lifecycle(join(value)),
      devices: deviceState,
      updateDevice: (value: typeof DeviceUpdate.Type) => lifecycle(updateDevice(value)),
      exportKey,
      sessions,
      hydrate,
      deleteSession: (value: typeof DeleteSessionInput.Type) => lifecycle(deleteSession(value)),
    }
  })

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const auth = yield* Auth.Service
    return yield* make({ credentialStore: async () => BaiduCredential.auth(auth) })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Database.node,
    EventV2.node,
    SyncSetup.node,
    SyncEventStore.node,
    SyncMetadata.node,
    SyncDatabase.node,
    SyncOwnership.node,
    SyncMembership.node,
    TargetBindingRegistry.node,
    TargetRegistry.node,
    SessionActivity.node,
    SessionLocationMutation.node,
    Auth.node,
  ],
})

export function codecFor(config: Pick<SyncState.Active, "namespaceID" | "encryption">, store: SyncSecureStore.Store) {
  if (config.encryption === "none") return Effect.succeed(SyncCodec.plaintext())
  return Effect.tryPromise({
    try: async () => {
      const encoded = await store.get(`space:${config.namespaceID}:root`)
      if (!encoded) throw new Error("Missing sync-space root key")
      return SyncCodec.encrypted(new Uint8Array(Buffer.from(encoded, "base64url")))
    },
    catch: () => new ControlError({ kind: "locked" }),
  })
}

export function portableTargetResolvable(
  label: string,
  bindings: ReadonlyMap<string, unknown>,
  targets: readonly Pick<TargetRegistry.Definition, "name">[],
) {
  return bindings.has(label) || targets.some((target) => target.name === label)
}

export function portableTargetMetadata(input: {
  readonly deviceID: string
  readonly deviceName: string
  readonly lastKnownTargetName?: string
  readonly indexed?: Pick<SyncMetadata.Item, "ownerDeviceID" | "targetLabel">
}) {
  if (input.indexed && input.indexed.ownerDeviceID !== input.deviceID)
    return {
      ownerDeviceID: input.indexed.ownerDeviceID,
      ...(input.indexed.targetLabel ? { targetLabel: input.indexed.targetLabel } : {}),
    }
  return { ownerDeviceID: input.deviceID, targetLabel: input.lastKnownTargetName ?? input.deviceName }
}

export async function flushBeforeSwitch(input: {
  readonly pending: () => Promise<number>
  readonly flush: () => Promise<void>
  readonly force: boolean
}) {
  const before = await input.pending()
  if (!before) return
  try {
    await input.flush()
  } catch {
    const remaining = await input.pending()
    if (!remaining) return
    if (input.force) return
    return { status: "blocked", reason: "pending-outbox", outbox: remaining, error: "flush-failed" } as const
  }
  const remaining = await input.pending()
  if (remaining && !input.force) return { status: "blocked", reason: "pending-outbox", outbox: remaining } as const
}

export function assertCanRevoke(currentDeviceID: string, deviceID: string) {
  if (currentDeviceID === deviceID) throw new ControlError({ kind: "invalid" })
}

export function schedulerInterval(seconds: SyncState.IntervalSeconds) {
  return seconds * 1_000
}

function activeIdentity(config: SyncState.Active) {
  return [
    config.namespaceID,
    config.deviceID,
    config.deviceName,
    config.account.id,
    config.encryption,
    config.remoteRoot,
  ].join("\u0000")
}

const AUTOMATIC_TICK_INTERVAL = 1_000
// Baidu commits a small segment/head pair in several seconds. Probe often
// enough that a completed upload still has room for receive/hydrate inside the
// product's 15-second cross-device visibility budget.
const REMOTE_PROBE_INTERVAL = 2_000
const AUTOMATIC_MAXIMUM_BACKOFF = 8_000
const AUTOMATIC_LEASE_TTL = 12_000
const AUTOMATIC_LEASE_HEARTBEAT = 4_000
const SETUP_FENCE_SCOPE = "__sync_setup__"
const PROJECTION_POLL_INTERVAL = 500
const MANUAL_RUN_WAIT = 20_000
