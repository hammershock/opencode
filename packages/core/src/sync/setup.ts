export * as SyncSetup from "./setup"

import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { Context, Effect, Layer, Schema } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import { BaiduSyncProvider } from "./baidu-provider"
import { SyncCrypto } from "./crypto"
import { SyncSecureStore } from "./secure-store"
import { SyncProvider } from "./provider"

export const Config = Schema.Struct({
  version: Schema.Literal(1),
  provider: Schema.Literal("baidu"),
  namespaceID: Schema.NonEmptyString,
  deviceID: Schema.NonEmptyString,
  deviceName: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  intervalSeconds: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(5)),
  remoteRoot: Schema.NonEmptyString,
})
export type Config = typeof Config.Type

export const Legacy = Schema.Struct({
  available: Schema.Boolean,
  unavailable: Schema.optional(Schema.Boolean),
  deviceID: Schema.optional(Schema.String),
})
export type Legacy = typeof Legacy.Type

export const BeginInput = Schema.Struct({
  appKey: Schema.NonEmptyString,
  secretKey: Schema.NonEmptyString,
  deviceName: Schema.NonEmptyString,
  recoveryString: Schema.optional(Schema.String),
  redirectURI: Schema.optional(Schema.String),
  resetExisting: Schema.optional(Schema.Boolean),
})
export type BeginInput = typeof BeginInput.Type
export const BeginResult = Schema.Struct({ attemptID: Schema.String, authorizationURL: Schema.String })
export const CompleteInput = Schema.Struct({ attemptID: Schema.String, code: Schema.NonEmptyString })
export type CompleteInput = typeof CompleteInput.Type
export const ReuseLegacyInput = Schema.Struct({
  deviceName: Schema.NonEmptyString,
  recoveryString: Schema.optional(Schema.String),
  resetExisting: Schema.optional(Schema.Boolean),
})
export type ReuseLegacyInput = typeof ReuseLegacyInput.Type
export const SetupResult = Schema.Struct({ config: Config, recoveryString: Schema.String })
export const EnabledInput = Schema.Struct({ enabled: Schema.Boolean })

export class SetupError extends Schema.TaggedErrorClass<SetupError>()("SyncSetupError", {
  kind: Schema.Literals(["invalid", "credential", "oauth", "remote", "storage", "expired"]),
}) {}

export interface Interface {
  readonly config: () => Effect.Effect<Config | undefined, SetupError>
  readonly inspectLegacy: () => Effect.Effect<Legacy, SetupError>
  readonly begin: (input: BeginInput) => Effect.Effect<typeof BeginResult.Type, SetupError>
  readonly complete: (input: CompleteInput) => Effect.Effect<typeof SetupResult.Type, SetupError>
  readonly reuseLegacy: (input: ReuseLegacyInput) => Effect.Effect<typeof SetupResult.Type, SetupError>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<Config, SetupError>
  readonly reset: () => Effect.Effect<typeof SetupResult.Type, SetupError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncSetup") {}

type Pending = {
  readonly appKey: string
  readonly secretKey: string
  readonly deviceName: string
  readonly redirectURI: string
  readonly space?: SyncCrypto.SpaceKey
  readonly resetExisting?: boolean
  readonly expiresAt: number
}

export function make(input: {
  readonly configDirectory: string
  readonly store: SyncSecureStore.Store
  readonly legacyStore: SyncSecureStore.Store
  readonly request?: BaiduSyncProvider.Request
  readonly now?: () => number
}) {
  const now = input.now ?? Date.now
  const attempts = new Map<string, Pending>()
  const directory = path.join(input.configDirectory, "sync")
  const filename = path.join(directory, "config.json")
  const legacyFilename = path.join(input.configDirectory, "cloud-sync", "legacy-config.json")

  const config = Effect.fn("SyncSetup.config")(() =>
    Effect.tryPromise({
      try: async () => {
        const value = await fs.readFile(filename, "utf8").catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === "ENOENT") return undefined
          throw cause
        })
        return value ? Schema.decodeUnknownSync(Config)(JSON.parse(value)) : undefined
      },
      catch: () => new SetupError({ kind: "storage" }),
    }),
  )

  const inspectLegacy = Effect.fn("SyncSetup.inspectLegacy")(() =>
    Effect.tryPromise({
      try: async () => {
        const text = await fs.readFile(legacyFilename, "utf8").catch(() => undefined)
        if (!text) return { available: false }
        const value = JSON.parse(text) as Record<string, unknown>
        if (value.provider !== "baidu" || typeof value.deviceID !== "string" || !value.deviceID)
          return { available: false }
        try {
          return { available: Boolean(await input.legacyStore.get(value.deviceID)), deviceID: value.deviceID }
        } catch (cause) {
          if (cause instanceof SyncSecureStore.SecureStoreUnavailableError)
            return { available: false, unavailable: true, deviceID: value.deviceID }
          throw cause
        }
      },
      catch: () => new SetupError({ kind: "storage" }),
    }),
  )

  const begin = Effect.fn("SyncSetup.begin")(function* (setup: BeginInput) {
    // Refuse before collecting/validating OAuth credentials.  `resetExisting`
    // is the explicit confirmation boundary; finish() repeats the check to
    // close the race with another OpenCode process writing config.json.
    if ((yield* config()) && !setup.resetExisting) return yield* new SetupError({ kind: "invalid" })
    const appKey = setup.appKey.trim()
    const secretKey = setup.secretKey.trim()
    const deviceName = setup.deviceName.trim()
    if (!appKey || !secretKey || !deviceName) return yield* new SetupError({ kind: "invalid" })
    const space = setup.recoveryString
      ? yield* Effect.tryPromise({
          try: () => SyncCrypto.importRecoveryString(setup.recoveryString!),
          catch: () => new SetupError({ kind: "invalid" }),
        })
      : undefined
    const attemptID = crypto.randomUUID()
    const redirectURI = setup.redirectURI ?? "oob"
    attempts.set(attemptID, {
      appKey,
      secretKey,
      deviceName,
      redirectURI,
      space,
      resetExisting: setup.resetExisting,
      expiresAt: now() + 10 * 60_000,
    })
    return { attemptID, authorizationURL: BaiduSyncProvider.authorizationURL(appKey, redirectURI) }
  })

  const complete = Effect.fn("SyncSetup.complete")(function* (setup: CompleteInput) {
    const pending = attempts.get(setup.attemptID)
    attempts.delete(setup.attemptID)
    if (!pending || pending.expiresAt < now()) return yield* new SetupError({ kind: "expired" })
    const credential = yield* Effect.tryPromise({
      try: () =>
        BaiduSyncProvider.exchangeCode({
          appKey: pending.appKey,
          secretKey: pending.secretKey,
          code: setup.code,
          redirectURI: pending.redirectURI,
          request: input.request,
          now,
        }),
      catch: () => new SetupError({ kind: "oauth" }),
    })
    return yield* finish({
      credential,
      deviceName: pending.deviceName,
      space: pending.space,
      resetExisting: pending.resetExisting,
    })
  })

  const reuseLegacy = Effect.fn("SyncSetup.reuseLegacy")(function* (setup: ReuseLegacyInput) {
    if ((yield* config()) && !setup.resetExisting) return yield* new SetupError({ kind: "invalid" })
    const legacy = yield* inspectLegacy()
    if (!legacy.available || !legacy.deviceID) return yield* new SetupError({ kind: "credential" })
    const current = yield* Effect.tryPromise({
      try: () => input.legacyStore.get(legacy.deviceID!),
      catch: () => new SetupError({ kind: "credential" }),
    })
    if (!current) return yield* new SetupError({ kind: "credential" })
    const parsed = yield* Effect.try({
      try: () => JSON.parse(current) as BaiduSyncProvider.Credential,
      catch: () => new SetupError({ kind: "credential" }),
    })
    const credential =
      parsed.expiresAt > now() + 60_000
        ? parsed
        : yield* Effect.tryPromise({
            try: () => BaiduSyncProvider.refreshCredential({ credential: parsed, request: input.request, now }),
            catch: () => new SetupError({ kind: "oauth" }),
          })
    const space = setup.recoveryString
      ? yield* Effect.tryPromise({
          try: () => SyncCrypto.importRecoveryString(setup.recoveryString!),
          catch: () => new SetupError({ kind: "invalid" }),
        })
      : undefined
    return yield* finish({
      credential,
      deviceName: setup.deviceName.trim(),
      space,
      resetExisting: setup.resetExisting,
    })
  })

  const finish = Effect.fn("SyncSetup.finish")(function* (setup: {
    readonly credential: BaiduSyncProvider.Credential
    readonly deviceName: string
    readonly space?: SyncCrypto.SpaceKey
    readonly resetExisting?: boolean
  }) {
    if (!setup.deviceName) return yield* new SetupError({ kind: "invalid" })
    const existing = yield* config()
    if (existing && !setup.resetExisting) return yield* new SetupError({ kind: "invalid" })
    const space = setup.space ?? SyncCrypto.createSpace()
    const deviceID = crypto.randomUUID()
    const remoteRoot = `/apps/opencode-sync/${space.namespaceID}`
    const provider = BaiduSyncProvider.adapter({
      store: ephemeral(setup.credential),
      deviceID,
      root: remoteRoot,
      request: input.request,
      now,
    })
    const protocol = new TextEncoder().encode(JSON.stringify({ version: 1, namespaceID: space.namespaceID }))
    yield* Effect.tryPromise({
      try: async () => {
        if (!setup.space) await provider.uploadAtomic("protocol.json", protocol, { type: "absent" })
        if (setup.space) {
          const info = await provider.stat("protocol.json")
          if (!info) throw new Error("Missing sync protocol")
          const value = JSON.parse(
            new TextDecoder().decode((await provider.download("protocol.json", info.version)).bytes),
          )
          if (value.version !== 1 || value.namespaceID !== space.namespaceID) throw new Error("Invalid sync protocol")
        }
      },
      catch: () => new SetupError({ kind: "remote" }),
    })
    const recoveryString = yield* Effect.promise(() => SyncCrypto.exportRecoveryString(space))
    const next: Config = {
      version: 1,
      provider: "baidu",
      namespaceID: space.namespaceID,
      deviceID,
      deviceName: setup.deviceName,
      enabled: true,
      intervalSeconds: 30,
      remoteRoot,
    }
    yield* Effect.tryPromise({
      try: async () => {
        try {
          await input.store.set(BaiduSyncProvider.credentialAccount(deviceID), JSON.stringify(setup.credential))
          await input.store.set(`space:${space.namespaceID}:root`, Buffer.from(space.rootKey).toString("base64url"))
          await atomicJson(filename, next)
        } catch (cause) {
          await Promise.allSettled([
            input.store.remove(BaiduSyncProvider.credentialAccount(deviceID)),
            input.store.remove(`space:${space.namespaceID}:root`),
          ])
          throw cause
        }
      },
      catch: () => new SetupError({ kind: "storage" }),
    })
    return { config: next, recoveryString }
  })

  const setEnabled = Effect.fn("SyncSetup.setEnabled")(function* (enabled: boolean) {
    const current = yield* config()
    if (!current) return yield* new SetupError({ kind: "invalid" })
    const next = { ...current, enabled }
    yield* Effect.tryPromise({
      try: () => atomicJson(filename, next),
      catch: () => new SetupError({ kind: "storage" }),
    })
    return next
  })

  const reset = Effect.fn("SyncSetup.reset")(function* () {
    const current = yield* config()
    if (!current) return yield* new SetupError({ kind: "invalid" })
    const credential = yield* Effect.tryPromise({
      try: () => BaiduSyncProvider.readCredential(input.store, current.deviceID),
      catch: () => new SetupError({ kind: "credential" }),
    })
    if (!credential) return yield* new SetupError({ kind: "credential" })
    const provider = BaiduSyncProvider.adapter({
      store: input.store,
      deviceID: current.deviceID,
      root: current.remoteRoot,
      request: input.request,
      now,
    })
    yield* Effect.tryPromise({
      try: async () => {
        const groups = await Promise.all(
          ["devices", "segments", "chunks"].map((prefix) => SyncProvider.listAll(provider, prefix)),
        )
        const protocol = await provider.stat("protocol.json")
        const objects = [...groups.flat(), ...(protocol ? [protocol] : [])]
        if (!objects.length) return
        const deleted = await provider.deleteBatch(objects)
        if (deleted.some((item) => item.status === "conflict")) throw new Error("Remote sync reset conflicted")
      },
      catch: () => new SetupError({ kind: "remote" }),
    })
    return yield* finish({ credential, deviceName: current.deviceName, resetExisting: true })
  })

  return Service.of({ config, inspectLegacy, begin, complete, reuseLegacy, setEnabled, reset })
}

function ephemeral(credential: BaiduSyncProvider.Credential): SyncSecureStore.Store {
  return {
    platform: "macos-keychain",
    get: async () => JSON.stringify(credential),
    set: async () => undefined,
    remove: async () => undefined,
  }
}

async function atomicJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, filename)
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return make({
      configDirectory: global.config,
      store: lazyStore(() => SyncSecureStore.detect()),
      legacyStore: lazyStore(() => SyncSecureStore.detectLegacyBaidu()),
    })
  }),
)

function lazyStore(load: () => Promise<SyncSecureStore.Store>): SyncSecureStore.Store {
  return {
    platform: "macos-keychain",
    get: async (account) => (await load()).get(account),
    set: async (account, secret) => (await load()).set(account, secret),
    remove: async (account) => (await load()).remove(account),
  }
}

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })
