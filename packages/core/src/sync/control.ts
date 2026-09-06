export * as SyncControl from "./control"

import path from "node:path"
import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { makeGlobalNode } from "../effect/app-node"
import { Global } from "../global"
import { Database } from "../database/database"
import { SessionTable } from "../session/sql"
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

export const Status = Schema.Struct({
  configured: Schema.Boolean,
  enabled: Schema.Boolean,
  locked: Schema.Boolean,
  provider: Schema.optional(Schema.String),
  namespaceID: Schema.optional(Schema.String),
  deviceID: Schema.optional(Schema.String),
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

export class ControlError extends Schema.TaggedErrorClass<ControlError>()("SyncControlError", {
  kind: Schema.Literals(["unconfigured", "locked", "provider", "storage"]),
}) {}

export interface Interface {
  readonly status: () => Effect.Effect<Status, ControlError>
  readonly now: () => Effect.Effect<void, ControlError>
  readonly enable: (enabled: boolean) => Effect.Effect<void, ControlError>
  readonly devices: () => Effect.Effect<SyncDevice.State, ControlError>
  readonly updateDevice: (input: typeof DeviceUpdate.Type) => Effect.Effect<SyncDevice.State, ControlError>
  readonly updateBinding: (input: typeof BindingUpdate.Type) => Effect.Effect<SyncDevice.State, ControlError>
  readonly exportKey: () => Effect.Effect<typeof Recovery.Type, ControlError>
}
export class Service extends Context.Service<Service, Interface>()("@opencode/SyncControl") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const setup = yield* SyncSetup.Service
    const store = yield* SyncEventStore.Service
    const events = yield* EventV2.Service
    const metadata = yield* SyncMetadata.Service
    const syncDB = (yield* SyncDatabase.Service).db
    const sessionDB = (yield* Database.Service).db
    const global = yield* Global.Service
    const devices = SyncDevice.make(path.join(global.config, "sync", "state.json"))
    let lastSuccessAt: number | undefined
    let lastError: string | undefined
    let engine: ReturnType<typeof SyncRuntime.make> | undefined
    let engineIdentity: string | undefined

    const load = Effect.fn("SyncControl.load")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
      const identity = `${config.namespaceID}:${config.deviceID}:${config.enabled}`
      if (engine && engineIdentity === identity) return engine
      const secure = yield* Effect.tryPromise({
        try: () => SyncSecureStore.detect(),
        catch: () => new ControlError({ kind: "locked" }),
      })
      const [credential, encodedKey] = yield* Effect.tryPromise({
        try: () =>
          Promise.all([
            BaiduSyncProvider.readCredential(secure, config.deviceID),
            secure.get(`space:${config.namespaceID}:root`),
          ]),
        catch: () => new ControlError({ kind: "locked" }),
      })
      if (!credential || !encodedKey) return yield* new ControlError({ kind: "locked" })
      const rootKey = new Uint8Array(Buffer.from(encodedKey, "base64url"))
      const provider = BaiduSyncProvider.adapter({ store: secure, deviceID: config.deviceID, root: config.remoteRoot })
      engine = SyncRuntime.make({
        config: {
          deviceID: SyncEvent.DeviceID.make(config.deviceID),
          deviceName: config.deviceName,
          enabled: config.enabled,
        },
        rootKey,
        provider,
        store,
        projector: (deviceID) => SessionSync.projector(events, deviceID),
        metadata: () =>
          sessionDB
            .select()
            .from(SessionTable)
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
            .all<{ device_id: string; cursor: number }>(sql`SELECT device_id, cursor FROM sync_event_cursor`)
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
      const config = yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined)))
      const outbox =
        (yield* syncDB.get<{ value: number }>(sql`SELECT COUNT(*) AS value FROM sync_event_outbox`))?.value ?? 0
      const cursorRows = yield* syncDB.all<{ device_id: string; cursor: number }>(
        sql`SELECT device_id, cursor FROM sync_event_cursor`,
      )
      return Status.make({
        configured: Boolean(config),
        enabled: config?.enabled ?? false,
        locked: lastError === "locked",
        provider: config?.provider,
        namespaceID: config?.namespaceID,
        deviceID: config?.deviceID,
        outbox,
        cursors: Object.fromEntries(cursorRows.map((row) => [row.device_id, row.cursor])),
        lastSuccessAt,
        error: lastError,
      })
    })
    const status = () => readStatus().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
    const now = Effect.fn("SyncControl.now")(function* () {
      const runtime = yield* load()
      yield* runtime.now().pipe(Effect.mapError(() => new ControlError({ kind: "provider" })))
      lastSuccessAt = Date.now()
      lastError = undefined
    })
    const scheduler = SyncScheduler.make({
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
    const configured = yield* setup.config().pipe(Effect.catch(() => Effect.succeed(undefined)))
    if (configured?.enabled) scheduler.start()
    yield* Effect.addFinalizer(() => Effect.sync(() => scheduler.stop()))
    const enable = Effect.fn("SyncControl.enable")(function* (enabled: boolean) {
      yield* setup.setEnabled(enabled).pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      engine = undefined
      if (enabled) scheduler.start()
      else scheduler.stop()
    })
    const deviceState = () =>
      Effect.tryPromise({ try: () => devices.read(), catch: () => new ControlError({ kind: "storage" }) })
    const updateDevice = Effect.fn("SyncControl.updateDevice")(function* (input: typeof DeviceUpdate.Type) {
      yield* Effect.tryPromise({
        try: async () => {
          if (input.name) await devices.rename(input.id, input.name)
          if (input.revoke) await devices.revoke(input.id)
        },
        catch: () => new ControlError({ kind: "storage" }),
      })
      engine = undefined
      return yield* deviceState()
    })
    const updateBinding = Effect.fn("SyncControl.updateBinding")(function* (input: typeof BindingUpdate.Type) {
      yield* Effect.tryPromise({
        try: () => (input.targetID ? devices.bind(input.label, input.targetID) : devices.unbind(input.label)),
        catch: () => new ControlError({ kind: "storage" }),
      })
      return yield* deviceState()
    })
    const exportKey = Effect.fn("SyncControl.exportKey")(function* () {
      const config = yield* setup.config().pipe(Effect.mapError(() => new ControlError({ kind: "storage" })))
      if (!config) return yield* new ControlError({ kind: "unconfigured" })
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
    return { status, now, enable, devices: deviceState, updateDevice, updateBinding, exportKey }
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
  ],
})
