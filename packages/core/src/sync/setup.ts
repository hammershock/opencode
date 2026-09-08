export * as SyncSetup from "./setup"

import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import { BaiduAuth } from "./baidu-auth"
import { BaiduSyncProvider } from "./baidu-provider"
import { SyncCrypto } from "./crypto"
import { SyncProvider } from "./provider"
import { SyncSecureStore } from "./secure-store"
import { SyncSpace } from "./space"
import { SyncSpaceCatalog } from "./space-catalog"
import { SyncState } from "./state"
import { SyncRuntime } from "./runtime"
import { SyncRoot } from "./root"

export const BeginInput = Schema.Struct({
  redirectURI: Schema.NonEmptyString,
  completion: Schema.Literals(["loopback", "manual"]),
})
export type BeginInput = typeof BeginInput.Type
export const CompleteInput = Schema.Struct({
  attemptID: Schema.NonEmptyString,
  response: Schema.Union([
    Schema.Struct({ type: Schema.Literal("loopback"), callbackURL: Schema.NonEmptyString }),
    Schema.Struct({ type: Schema.Literal("manual"), code: Schema.NonEmptyString }),
  ]),
})
export type CompleteInput = typeof CompleteInput.Type
export const CreateInput = Schema.Struct({
  name: Schema.NonEmptyString,
  encryption: Schema.optional(SyncSpace.Encryption),
})
export type CreateInput = typeof CreateInput.Type
export const JoinInput = Schema.Struct({
  namespaceID: Schema.NonEmptyString,
  recoveryString: Schema.optional(Schema.NonEmptyString),
})
export type JoinInput = typeof JoinInput.Type

export const INCOMPATIBLE_LOCAL_STATE_MESSAGE =
  "Local sync state is incompatible. Archive the local sync folder and restart opencode-rexd."

export class SetupError extends Schema.TaggedErrorClass<SetupError>()("SyncSetupError", {
  kind: Schema.Literals([
    "uninitialized",
    "unauthenticated",
    "account-mismatch",
    "invalid",
    "oauth",
    "missing-app",
    "incompatible-local-state",
    "remote",
    "storage",
    "locked",
    "remote-uninitialized",
    "incompatible-remote",
  ]),
  diagnostic: Schema.optional(SyncRuntime.Diagnostic),
}) {}

export interface Interface {
  /** Reads device/account/space state only. It never opens secure storage. */
  readonly state: () => Effect.Effect<SyncState.State | undefined, SetupError>
  /** Returns the single active runtime scope, separately from full lifecycle state. */
  readonly config: () => Effect.Effect<SyncState.Active | undefined, SetupError>
  readonly authenticated: () => Effect.Effect<boolean, SetupError>
  readonly initialize: (deviceName: string) => Effect.Effect<SyncState.State, SetupError>
  readonly begin: (input: BeginInput) => Effect.Effect<BaiduAuth.BeginResult, SetupError>
  readonly complete: (input: CompleteInput) => Effect.Effect<SyncState.State, SetupError>
  readonly switchAccount: (input: CompleteInput) => Effect.Effect<SyncState.State, SetupError>
  readonly logout: () => Effect.Effect<SyncState.State, SetupError>
  readonly cloudStatus: () => Effect.Effect<SyncRoot.Inspection, SetupError>
  readonly initializeCloud: () => Effect.Effect<SyncState.State, SetupError>
  readonly clearCloud: () => Effect.Effect<SyncState.State, SetupError>
  readonly discover: () => Effect.Effect<SyncSpaceCatalog.Discovery, SetupError>
  readonly create: (input: CreateInput) => Effect.Effect<
    {
      readonly state: SyncState.State
      readonly descriptor: SyncSpace.Descriptor
      readonly recoveryString?: string
    },
    SetupError
  >
  readonly join: (input: JoinInput) => Effect.Effect<SyncState.State, SetupError>
  readonly activate: (namespaceID: string) => Effect.Effect<SyncState.State, SetupError>
  readonly leave: (namespaceID: string) => Effect.Effect<SyncState.State, SetupError>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<SyncState.State, SetupError>
  readonly setInterval: (seconds: SyncState.IntervalSeconds) => Effect.Effect<SyncState.State, SetupError>
  readonly deleteSpace: (namespaceID: string) => Effect.Effect<string, SetupError>
  readonly applyRemoteDeletion: (namespaceID: string) => Effect.Effect<boolean, SetupError>
  readonly removeFromDevice: () => Effect.Effect<readonly string[], SetupError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncSetup") {}

export function make(input: {
  readonly configDirectory: string
  readonly store: SyncSecureStore.Store
  readonly request?: BaiduSyncProvider.Request
  readonly now?: () => number
  readonly randomUUID?: () => string
  readonly createSpace?: () => SyncCrypto.SpaceKey
  readonly provider?: SyncProvider.Adapter
}) {
  const states = SyncState.make(input.configDirectory)
  const now = input.now ?? Date.now
  const state = () => effect("storage", () => states.read())
  const config = Effect.fn("SyncSetup.config")(function* () {
    const current = yield* state()
    return current ? SyncState.active(current) : undefined
  })
  const authenticated = Effect.fn("SyncSetup.authenticated")(function* () {
    const current = yield* state()
    if (!current?.account) return false
    const account = yield* effect("storage", () => BaiduAuth.account(input.store, current.deviceID))
    return account?.id === current.account.id
  })
  const initialize = Effect.fn("SyncSetup.initialize")((deviceName: string) =>
    effect("storage", async () => {
      const current = await states.read()
      if (current) return current
      return states.write(SyncState.empty(deviceName, input.randomUUID?.()))
    }),
  )
  const begin = Effect.fn("SyncSetup.begin")(function* (values: BeginInput) {
    const current = yield* requireState(state)
    return yield* authEffect(() =>
      BaiduAuth.begin({
        store: input.store,
        deviceID: current.deviceID,
        redirectURI: values.redirectURI,
        completion: values.completion,
        now,
        randomUUID: input.randomUUID,
      }),
    )
  })
  const finishAuth = (values: CompleteInput, switching: boolean) =>
    Effect.gen(function* () {
      const current = yield* requireState(state)
      const account = yield* authEffect(() =>
        (switching ? BaiduAuth.switchAccount : BaiduAuth.complete)({
          store: input.store,
          deviceID: current.deviceID,
          attemptID: values.attemptID,
          response: values.response,
          request: input.request,
          now,
        }),
      )
      return yield* effect("storage", () =>
        states.write(
          {
            ...current,
            account: { id: account.id, maskedDisplay: account.maskedDisplay },
            enabled: false,
            activeSpaceID: current.account?.id === account.id ? current.activeSpaceID : undefined,
            spaces: current.account?.id === account.id ? current.spaces : [],
          },
          current.revision,
        ),
      )
    })
  const complete = Effect.fn("SyncSetup.complete")((values: CompleteInput) => finishAuth(values, false))
  const switchAccount = Effect.fn("SyncSetup.switchAccount")((values: CompleteInput) => finishAuth(values, true))
  const logout = Effect.fn("SyncSetup.logout")(function* () {
    const current = yield* requireState(state)
    yield* effect("storage", () =>
      Promise.all([
        input.store.remove(BaiduSyncProvider.credentialAccount(current.deviceID)),
        input.store.remove(BaiduAuth.pendingAccount(current.deviceID)),
      ]).then(() => undefined),
    )
    return yield* effect("storage", () =>
      states.write({ ...current, enabled: false, activeSpaceID: undefined }, current.revision),
    )
  })
  const remote = async () => {
    const current = await states.read()
    if (!current) throw new SetupError({ kind: "uninitialized" })
    if (!current.account) throw new SetupError({ kind: "unauthenticated" })
    const credentialAccount = await BaiduAuth.account(input.store, current.deviceID)
    if (!credentialAccount) throw new SetupError({ kind: "unauthenticated" })
    if (credentialAccount.id !== current.account.id) throw new SetupError({ kind: "account-mismatch" })
    const provider =
      input.provider ??
      BaiduSyncProvider.adapter({
        store: input.store,
        deviceID: current.deviceID,
        root: SyncRoot.REMOTE_ROOT,
        request: input.request,
        now,
      })
    return {
      current,
      root: SyncRoot.make({ provider, now }),
      catalog: SyncSpaceCatalog.make({
        provider,
        now,
        createSpace: input.createSpace,
      }),
    }
  }
  const cloudStatus = Effect.fn("SyncSetup.cloudStatus")(() =>
    effect("remote", async () => (await remote()).root.inspect(), "catalog"),
  )
  const initializeCloud = Effect.fn("SyncSetup.initializeCloud")(() =>
    effect(
      "remote",
      async () => {
        const context = await remote()
        const manifest = await context.root.initialize()
        const descriptor: SyncSpace.Descriptor = {
          namespaceID: SyncRoot.INTERNAL_SCOPE,
          name: "Baidu Netdisk",
          protocol: manifest.protocol,
          encryption: "none",
          createdAt: manifest.createdAt,
          updatedAt: manifest.createdAt,
          summary: { sessions: 0, devices: 0, updatedAt: manifest.createdAt },
          revision: 1,
        }
        const accountState = {
          ...context.current,
          activeSpaceID: undefined,
          spaces: [],
        }
        return states.write(
          SyncState.activate(
            SyncState.bind(accountState, {
              accountID: context.current.account!.id,
              descriptor,
              remoteRoot: SyncRoot.REMOTE_ROOT,
              joinedAt: now(),
            }),
            SyncRoot.INTERNAL_SCOPE,
          ),
          context.current.revision,
        )
      },
      "catalog",
    ),
  )
  const clearCloud = Effect.fn("SyncSetup.clearCloud")(() =>
    effect(
      "remote",
      async () => {
        const context = await remote()
        await context.root.clear()
        return states.update((current) => ({
          ...current,
          enabled: false,
          activeSpaceID: undefined,
          spaces: current.spaces.filter((item) => item.descriptor.namespaceID !== SyncRoot.INTERNAL_SCOPE),
        }))
      },
      "delete",
    ),
  )
  const discover = Effect.fn("SyncSetup.discover")(() =>
    effect("remote", async () => (await remote()).catalog.discover(), "catalog"),
  )
  const create = Effect.fn("SyncSetup.create")((values: CreateInput) =>
    effect(
      "remote",
      async () => {
        const context = await remote()
        const created = await context.catalog.create(values)
        if (created.descriptor.encryption === "aes-256-gcm") {
          const key = await SyncCrypto.importRecoveryString(created.recoveryString!)
          await input.store.set(rootAccount(key.namespaceID), Buffer.from(key.rootKey).toString("base64url"))
        }
        const next = await states.write(
          SyncState.bind(context.current, binding(context.current, created.descriptor, now())),
          context.current.revision,
        )
        return {
          state: next,
          descriptor: created.descriptor,
          ...(created.recoveryString ? { recoveryString: created.recoveryString } : {}),
        }
      },
      "catalog",
    ),
  )
  const join = Effect.fn("SyncSetup.join")((values: JoinInput) =>
    effect(
      "remote",
      async () => {
        const context = await remote()
        const joined = await context.catalog.join(values.namespaceID)
        if (joined.descriptor.encryption === "aes-256-gcm") {
          if (!values.recoveryString) throw new SetupError({ kind: "locked" })
          const key = await SyncCrypto.importRecoveryString(values.recoveryString).catch(() => {
            throw new SetupError({ kind: "locked" })
          })
          if (key.namespaceID !== values.namespaceID) throw new SetupError({ kind: "locked" })
          await input.store.set(rootAccount(values.namespaceID), Buffer.from(key.rootKey).toString("base64url"))
        }
        if (joined.descriptor.encryption === "none" && values.recoveryString) throw new SetupError({ kind: "invalid" })
        return states.write(
          SyncState.bind(context.current, binding(context.current, joined.descriptor, now())),
          context.current.revision,
        )
      },
      "catalog",
    ),
  )
  const activate = Effect.fn("SyncSetup.activate")((namespaceID: string) =>
    update(states, (current) => SyncState.activate(current, namespaceID)),
  )
  const leave = Effect.fn("SyncSetup.leave")((namespaceID: string) =>
    effect("storage", async () => {
      const current = await states.read()
      if (!current) throw new SetupError({ kind: "uninitialized" })
      const binding = current.spaces.find((item) => item.descriptor.namespaceID === namespaceID)
      if (!binding) throw new SetupError({ kind: "invalid" })
      if (binding.descriptor.encryption === "aes-256-gcm") await input.store.remove(rootAccount(namespaceID))
      return states.write(SyncState.remove(current, namespaceID), current.revision)
    }),
  )
  const setEnabled = Effect.fn("SyncSetup.setEnabled")((enabled: boolean) =>
    update(states, (current) => ({ ...current, enabled })),
  )
  const setInterval = Effect.fn("SyncSetup.setInterval")((intervalSeconds: SyncState.IntervalSeconds) =>
    update(states, (current) => ({ ...current, intervalSeconds })),
  )
  const deleteSpace = Effect.fn("SyncSetup.deleteSpace")(function* (namespaceID: string) {
    const context = yield* effect("remote", remote)
    const binding = context.current.spaces.find(
      (item) => item.descriptor.namespaceID === namespaceID && item.accountID === context.current.account?.id,
    )
    if (binding && !SyncSpace.compatible(binding.descriptor.protocol)) return yield* new SetupError({ kind: "invalid" })
    if (!binding) {
      const inspection = yield* deleteEffect(() =>
        context.catalog.inspect(namespaceID).catch((cause) => {
          if (cause instanceof SyncSpaceCatalog.CatalogError && cause.kind === "deleted") return undefined
          throw cause
        }),
      )
      if (inspection?.status === "unsupported") return yield* new SetupError({ kind: "invalid" })
    }
    yield* deleteEffect(() => context.catalog.remove(namespaceID))
    yield* effect("storage", () =>
      states.update((current) => {
        if (current.account?.id !== context.current.account?.id) throw new SetupError({ kind: "account-mismatch" })
        const spaces = current.spaces.filter(
          (item) => item.descriptor.namespaceID !== namespaceID || item.accountID !== context.current.account?.id,
        )
        return {
          ...current,
          spaces,
          activeSpaceID:
            current.activeSpaceID === namespaceID && spaces.length !== current.spaces.length
              ? undefined
              : current.activeSpaceID,
        }
      }),
    )
    if (binding?.descriptor.encryption === "aes-256-gcm")
      yield* Effect.tryPromise(() => input.store.remove(rootAccount(namespaceID))).pipe(Effect.ignore)
    return namespaceID
  })
  const applyRemoteDeletion = Effect.fn("SyncSetup.applyRemoteDeletion")((namespaceID: string) =>
    effect("remote", async () => {
      const context = await remote()
      const deleted = await context.catalog.inspect(namespaceID).then(
        () => false,
        (cause) => {
          if (cause instanceof SyncSpaceCatalog.CatalogError && cause.kind === "deleted") return true
          throw cause
        },
      )
      if (!deleted) return false
      const binding = context.current.spaces.find((item) => item.descriptor.namespaceID === namespaceID)
      if (binding?.descriptor.encryption === "aes-256-gcm") await input.store.remove(rootAccount(namespaceID))
      await states.write(SyncState.remove(context.current, namespaceID), context.current.revision)
      return true
    }),
  )
  const removeFromDevice = Effect.fn("SyncSetup.removeFromDevice")(() =>
    effect("storage", async () => {
      const current = await states.read()
      if (!current) return []
      const ids = current.spaces.map((item) => item.descriptor.namespaceID)
      await Promise.all([
        input.store.remove(BaiduSyncProvider.credentialAccount(current.deviceID)),
        input.store.remove(BaiduAuth.pendingAccount(current.deviceID)),
        ...current.spaces
          .filter((item) => item.descriptor.encryption === "aes-256-gcm")
          .map((item) => input.store.remove(rootAccount(item.descriptor.namespaceID))),
      ])
      await states.clear()
      return ids
    }),
  )
  return Service.of({
    state,
    config,
    authenticated,
    initialize,
    begin,
    complete,
    switchAccount,
    logout,
    cloudStatus,
    initializeCloud,
    clearCloud,
    discover,
    create,
    join,
    activate,
    leave,
    setEnabled,
    setInterval,
    deleteSpace,
    applyRemoteDeletion,
    removeFromDevice,
  })
}

function requireState(read: Interface["state"]) {
  return read().pipe(
    Effect.flatMap((value) => (value ? Effect.succeed(value) : new SetupError({ kind: "uninitialized" }))),
  )
}
function binding(state: SyncState.State, descriptor: SyncSpace.Descriptor, joinedAt: number): SyncState.Binding {
  if (!state.account) throw new SetupError({ kind: "unauthenticated" })
  return {
    accountID: state.account.id,
    descriptor,
    remoteRoot:
      descriptor.namespaceID === SyncRoot.INTERNAL_SCOPE
        ? SyncRoot.REMOTE_ROOT
        : `${SyncRoot.REMOTE_ROOT}/spaces/${descriptor.namespaceID}`,
    joinedAt,
  }
}
function rootAccount(namespaceID: string) {
  return `space:${namespaceID}:root`
}
function update(store: ReturnType<typeof SyncState.make>, change: (current: SyncState.State) => SyncState.State) {
  return effect("storage", () => store.update(change))
}
function effect<A>(kind: SetupError["kind"], run: () => Promise<A>, stage?: SyncRuntime.Diagnostic["stage"]) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof SetupError
        ? cause
        : cause instanceof SyncState.IncompatibleLocalStateError
          ? new SetupError({ kind: "incompatible-local-state" })
          : new SetupError({ kind, diagnostic: stage ? SyncRuntime.diagnostic(stage, cause) : undefined }),
  })
}
function deleteEffect<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof SetupError
        ? cause
        : new SetupError({ kind: "remote", diagnostic: SyncRuntime.diagnostic("delete", cause) }),
  })
}
function authEffect<A>(run: () => Promise<A>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => {
      const kind =
        cause instanceof BaiduAuth.AuthError && cause.kind === "account-mismatch"
          ? "account-mismatch"
          : cause instanceof BaiduAuth.AuthError && cause.kind === "missing-app"
            ? "missing-app"
            : "oauth"
      return new SetupError({ kind })
    },
  })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return make({ configDirectory: global.config, store: lazyStore(() => SyncSecureStore.detect()) })
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
