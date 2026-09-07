export * as SyncControl from "./control"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { eq, sql } from "drizzle-orm"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { Database } from "../database/database"
import { SessionTable } from "../session/sql"
import { SessionV2 } from "../session"
import { EventV2 } from "../event"
import { BaiduSyncProvider } from "./baidu-provider"
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
import { SyncState } from "./state"

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
})
export type Status = typeof Status.Type
export const DeviceUpdate = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.optional(Schema.NonEmptyString),
  revoke: Schema.optional(Schema.Boolean),
})
export const BindingUpdate = Schema.Struct({
  label: Schema.NonEmptyString,
  targetID: Schema.optional(Schema.NonEmptyString),
})
export const Recovery = Schema.Struct({ recoveryString: Schema.NonEmptyString })
export const HydrateInput = Schema.Struct({ sessionID: Schema.NonEmptyString })
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
  kind: Schema.Literals(["unconfigured", "locked", "provider", "storage", "invalid", "pending", "deleted"]),
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Status, ControlError>
  readonly now: () => Effect.Effect<void, ControlError>
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
  readonly devices: () => Effect.Effect<SyncDevice.State, ControlError>
  readonly updateDevice: (input: typeof DeviceUpdate.Type) => Effect.Effect<SyncDevice.State, ControlError>
  readonly updateBinding: (input: typeof BindingUpdate.Type) => Effect.Effect<SyncDevice.State, ControlError>
  readonly exportKey: () => Effect.Effect<typeof Recovery.Type, ControlError>
  /** Index remote heads without downloading their complete Session histories. */
  readonly sessions: () => Effect.Effect<readonly SyncMetadata.Item[], ControlError>
  /** Hydrates the selected metadata-only Session before it is opened locally. */
  readonly hydrate: (input: typeof HydrateInput.Type) => Effect.Effect<typeof HydrateResult.Type, ControlError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SyncControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const setup = yield* SyncSetup.Service
    const eventStore = yield* SyncEventStore.Service
    const events = yield* EventV2.Service
    const metadataStore = yield* SyncMetadata.Service
    const syncDB = (yield* SyncDatabase.Service).db
    const ownership = yield* SyncOwnership.Service
    const membership = yield* SyncMembership.Service
    const sessionDB = (yield* Database.Service).db
    const global = yield* Global.Service
    const devicesFor = (namespaceID: string) =>
      SyncDevice.make(path.join(global.config, "sync", "spaces", namespaceID, "state.json"))
    let lastSuccessAt: number | undefined
    let lastError: string | undefined
    let engine: ReturnType<typeof SyncRuntime.make> | undefined
    let engineIdentity: string | undefined
    let scheduler: ReturnType<typeof SyncScheduler.make> | undefined

    const clearSpace = (namespaceID: string) =>
      SyncDatabase.purgeSpace(syncDB, namespaceID).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const purgeSpace = Effect.fn("SyncControl.purgeSpace")(function* (namespaceID: string) {
      const sessions = yield* membership
        .unassignSpace(namespaceID)
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* clearSpace(namespaceID)
      return sessions
    })
    const localState = yield* setup.state().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const stale = yield* membership
      .stale(new Set(localState?.spaces.map((item) => item.descriptor.namespaceID) ?? []))
      .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    yield* Effect.forEach(stale, purgeSpace, { discard: true })

    const load = Effect.fn("SyncControl.load")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      const store = eventStore.scope(config.namespaceID)
      const metadata = metadataStore.scope(config.namespaceID)
      const devices = devicesFor(config.namespaceID)
      const identity = `${config.namespaceID}:${config.deviceID}:${config.encryption}`
      if (engine && engineIdentity === identity) return engine
      const secure = yield* Effect.tryPromise({
        try: () => SyncSecureStore.detect(),
        catch: () => new ControlError({ kind: "locked" }),
      })
      const credential = yield* Effect.tryPromise({
        try: () => BaiduSyncProvider.readCredential(secure, config.deviceID),
        catch: () => new ControlError({ kind: "locked" }),
      })
      if (!credential) return yield* new ControlError({ kind: "locked" })
      const codec = yield* codecFor(config, secure)
      const provider = BaiduSyncProvider.adapter({ store: secure, deviceID: config.deviceID, root: config.remoteRoot })
      const attachment = SyncAttachment.make({ codec, namespaceID: config.namespaceID, provider })
      engine = SyncRuntime.make({
        config: {
          deviceID: SyncEvent.DeviceID.make(config.deviceID),
          deviceName: config.deviceName,
          enabled: true,
        },
        codec,
        provider,
        store,
        projector: (deviceID) =>
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
          ),
        attachment: {
          externalize: (event) => SessionSync.externalize(event, attachment),
          references: SyncAttachment.references,
          collect: attachment.collect,
        },
        metadata: () =>
          sessionDB
            .select()
            .from(SessionTable)
            .where(eq(SessionTable.sync_space_id, config.namespaceID))
            .all()
            .pipe(
              Effect.map((rows) =>
                rows.map((row) => ({
                  sessionID: row.id,
                  title: row.title,
                  ownerDeviceID: config.deviceID,
                  ...(row.last_known_target_name ? { targetLabel: row.last_known_target_name } : {}),
                  directory: row.directory,
                  revision: row.time_updated,
                  updatedAt: row.time_updated,
                })),
              ),
            ),
        metadataProjector: { apply: (values, deviceID) => metadata.apply(deviceID, values) },
        acknowledged: () =>
          syncDB
            .all<{ device_id: string; cursor: number }>(
              sql`
              SELECT device_id, cursor FROM sync_event_cursor WHERE space_id = ${config.namespaceID}
            `,
            )
            .pipe(Effect.map((rows) => Object.fromEntries(rows.map((row) => [row.device_id, row.cursor])))),
        revoked: () =>
          Effect.promise(() => devices.read()).pipe(
            Effect.map((state) =>
              state.devices.filter((item) => item.revoked).map((item) => SyncEvent.DeviceID.make(item.id)),
            ),
          ),
        deviceProjector: (head) =>
          Effect.promise(() =>
            devices.upsert({
              id: head.deviceID,
              name: head.deviceName,
              revision: head.generation,
              updatedAt: Date.now(),
              revoked: false,
            }),
          ).pipe(Effect.asVoid),
      })
      engineIdentity = identity
      return engine
    })

    const readStatus = Effect.fn("SyncControl.status")(function* () {
      const state = yield* setup.state().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const config = yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const authenticated = yield* setup.authenticated().pipe(Effect.catch(() => Effect.succeed(false)))
      const locked =
        config?.encryption === "aes-256-gcm" && authenticated
          ? yield* Effect.tryPromise({
              try: async () => !(await (await SyncSecureStore.detect()).get(`space:${config.namespaceID}:root`)),
              catch: () => true,
            })
          : false
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
        authenticated,
        enabled: state?.enabled ?? false,
        locked,
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
        error: lastError,
      })
    })
    const status = () => readStatus().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const now = Effect.fn("SyncControl.now")(function* () {
      const active = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!active) return yield* new ControlError({ kind: "unconfigured" })
      const deleted = yield* setup
        .applyRemoteDeletion(active.namespaceID)
        .pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      if (deleted) {
        scheduler?.stop()
        engine = undefined
        yield* purgeSpace(active.namespaceID)
        return yield* new ControlError({ kind: "deleted" })
      }
      const runtime = yield* load()
      yield* runtime.now().pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      lastSuccessAt = Date.now()
      lastError = undefined
    })
    const restartScheduler = (config?: SyncState.Active) => {
      scheduler?.stop()
      scheduler = undefined
      if (!config?.enabled) return
      scheduler = SyncScheduler.make({
        intervalMs: schedulerInterval(config.intervalSeconds),
        run: () =>
          Effect.runPromise(
            now().pipe(
              Effect.catch((error) =>
                Effect.sync(() => {
                  lastError = error.kind
                  return undefined
                }),
              ),
            ),
          ),
      })
      scheduler.start()
    }
    const configured = yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined)))
    restartScheduler(configured)
    yield* Effect.addFinalizer(() => Effect.sync(() => scheduler?.stop()))
    const enable = Effect.fn("SyncControl.enable")(function* (enabled: boolean) {
      yield* setup.setEnabled(enabled).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
    })
    const setInterval = Effect.fn("SyncControl.setInterval")(function* (seconds: SyncState.IntervalSeconds) {
      yield* setup.setInterval(seconds).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
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
        yield* setup.activate(input.namespaceID).pipe(Effect.mapError(() => new ControlError({ kind: "invalid" })))
        engine = undefined
        restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
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
      yield* setup.activate(input.namespaceID).pipe(Effect.mapError(() => new ControlError({ kind: "invalid" })))
      engine = undefined
      restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
      return SwitchResult.make({ status: "switched", namespaceID: input.namespaceID })
    })
    const deleteSpace = Effect.fn("SyncControl.deleteSpace")(function* (namespaceID: string) {
      const deleted = yield* setup
        .deleteSpace(namespaceID)
        .pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      const sessions = yield* purgeSpace(deleted)
      engine = undefined
      restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
      return sessions
    })
    const leaveSpace = Effect.fn("SyncControl.leaveSpace")(function* (namespaceID: string) {
      yield* setup.leave(namespaceID).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      const sessions = yield* purgeSpace(namespaceID)
      engine = undefined
      restartScheduler(yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
      return sessions
    })
    const removeFromDevice = Effect.fn("SyncControl.removeFromDevice")(function* () {
      const spaces = yield* setup.removeFromDevice().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      const sessions = yield* membership
        .unassignAll()
        .pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      yield* Effect.forEach(spaces, clearSpace, { discard: true })
      engine = undefined
      restartScheduler()
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
      yield* setup.logout().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      scheduler?.stop()
    })
    const switchAccount = Effect.fn("SyncControl.switchAccount")(function* (input: SyncSetup.CompleteInput) {
      const state = yield* setup
        .switchAccount(input)
        .pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      engine = undefined
      scheduler?.stop()
      return state
    })
    const deviceState = () =>
      setup.config().pipe(
        Effect.mapError(() => new ControlError({ kind: "storage" })),
        Effect.flatMap((config) =>
          config
            ? Effect.tryPromise({
                try: () => devicesFor(config.namespaceID).read(),
                catch: () => new ControlError({ kind: "storage" }),
              })
            : Effect.fail(new ControlError({ kind: "unconfigured" })),
        ),
      )
    const updateDevice = Effect.fn("SyncControl.updateDevice")(function* (input: typeof DeviceUpdate.Type) {
      yield* Effect.tryPromise({
        try: async () => {
          const config = await Effect.runPromise(setup.config())
          if (!config) throw new Error("Sync is not configured")
          if (input.revoke) assertCanRevoke(config.deviceID, input.id)
          const devices = devicesFor(config.namespaceID)
          if (input.name) await devices.rename(input.id, input.name)
          if (input.revoke) await devices.revoke(input.id)
        },
        catch: (cause) => (cause instanceof ControlError ? cause : new ControlError({ kind: "storage" })),
      })
      engine = undefined
      return yield* deviceState()
    })
    const updateBinding = Effect.fn("SyncControl.updateBinding")(function* (input: typeof BindingUpdate.Type) {
      yield* Effect.tryPromise({
        try: async () => {
          const config = await Effect.runPromise(setup.config())
          if (!config) throw new Error("Sync is not configured")
          const devices = devicesFor(config.namespaceID)
          return input.targetID ? devices.bind(input.label, input.targetID) : devices.unbind(input.label)
        },
        catch: () => new ControlError({ kind: "storage" }),
      })
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
      const devices = devicesFor(config.namespaceID)
      const [indexed, local, deviceState] = yield* Effect.all([
        metadata.list(),
        sessionDB.select({ id: SessionTable.id }).from(SessionTable).all(),
        Effect.tryPromise({ try: () => devices.read(), catch: () => new ControlError({ kind: "storage" }) }),
      ])
      const localIDs = new Set(local.map((item) => String(item.id)))
      return yield* Effect.forEach(indexed, (item) => {
        // A portable label is intentionally all that crosses devices. It is
        // unresolved until this device explicitly binds it to one of its own
        // targets; neither an SSH config nor a target ID is synced.
        const next: SyncMetadata.Availability =
          item.availability === "conflict"
            ? "conflict"
            : item.targetLabel && !deviceState.bindings[item.targetLabel]
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
      const runtime = yield* load()
      // Do not call now(): its hydration phase would defeat metadata-first
      // browsing. Selecting one of these rows calls hydrate below.
      yield* runtime.pull().pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      lastSuccessAt = Date.now()
      lastError = undefined
      return yield* availability()
    })
    const hydrateRaw = Effect.fn("SyncControl.hydrate")(function* (input: typeof HydrateInput.Type) {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      const metadata = metadataStore.scope(config.namespaceID)
      const runtime = yield* load()
      // Keep the typed API self-contained: callers are not required to visit
      // the metadata browser endpoint before requesting a Session.
      yield* runtime.pull().pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      const known = (yield* metadata.list()).find((item) => item.sessionID === input.sessionID)
      if (!known) return yield* new ControlError({ kind: "storage" })
      yield* metadata.availability(input.sessionID, "hydrating")
      const result = yield* runtime.hydrate().pipe(
        Effect.andThen(availability()),
        Effect.map((items) => items.find((item) => item.sessionID === input.sessionID)),
        Effect.catch(() =>
          metadata
            .availability(input.sessionID, "partial")
            .pipe(Effect.andThen(Effect.fail(new ControlError({ kind: "provider" })))),
        ),
      )
      lastSuccessAt = Date.now()
      lastError = undefined
      return HydrateResult.make({ sessionID: input.sessionID, availability: result?.availability ?? "partial" })
    })
    const hydrate = (input: typeof HydrateInput.Type) =>
      hydrateRaw(input).pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
    return {
      status,
      now,
      enable,
      setInterval,
      switchSpace,
      leaveSpace,
      deleteSpace,
      removeFromDevice,
      assignUnassigned,
      unassigned,
      logout,
      switchAccount,
      devices: deviceState,
      updateDevice,
      updateBinding,
      exportKey,
      sessions,
      hydrate,
    }
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [
    Global.node,
    Database.node,
    EventV2.node,
    SyncSetup.node,
    SyncEventStore.node,
    SyncMetadata.node,
    SyncDatabase.node,
    SyncOwnership.node,
    SyncMembership.node,
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
