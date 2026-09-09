import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Scope } from "effect"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { Database } from "@opencode-ai/core/database/database"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncRoot } from "@opencode-ai/core/sync/root"
import { SyncMembership } from "@opencode-ai/core/sync/membership"
import { testEffect } from "./lib/effect"

let remoteStarted = false
let releaseRemote = () => {}
let authenticationReads = 0
const active = {
  provider: "baidu" as const,
  deviceID: "device",
  deviceName: "Mac",
  account: { id: "account", maskedDisplay: "acc***" },
  namespaceID: SyncRoot.accountScope("control-test"),
  name: "Space",
  encryption: "none" as const,
  remoteRoot: SyncRoot.instanceRoot("control-test"),
  enabled: false,
  intervalSeconds: 30 as const,
}
const state = {
  version: 2 as const,
  revision: 0,
  provider: "baidu" as const,
  deviceID: active.deviceID,
  deviceName: active.deviceName,
  account: active.account,
  activeSpaceID: active.namespaceID,
  enabled: false,
  intervalSeconds: 30 as const,
  spaces: [],
}
const readyCloud = {
  status: "ready" as const,
  manifest: {
    version: 2 as const,
    state: "ready" as const,
    protocol: { major: 1 as const, minor: 0 },
    instanceID: "control-test",
    createdAt: 1,
  },
}
const realControlIt = testEffect(
  LayerNode.compile(SyncControl.node, [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
    [
      SyncSetup.node,
      Layer.mock(SyncSetup.Service, {
        state: () => Effect.succeed(state),
        config: () => Effect.succeed(active),
        authenticated: () =>
          Effect.sync(() => {
            authenticationReads++
            return true
          }),
        cloudStatus: () =>
          Effect.promise(
            () =>
              new Promise<typeof readyCloud>((resolve) => {
                remoteStarted = true
                releaseRemote = () => resolve(readyCloud)
              }),
          ),
        applyRemoteDeletion: () => Effect.succeed(false),
      }),
    ],
  ]),
)

const encrypted = {
  ...active,
  encryption: "aes-256-gcm" as const,
}
const encryptedState = {
  ...state,
  spaces: [
    {
      accountID: active.account.id,
      descriptor: {
        namespaceID: active.namespaceID,
        name: active.name,
        protocol: { major: 1 as const, minor: 0 },
        encryption: "aes-256-gcm" as const,
        createdAt: 1,
        updatedAt: 1,
        summary: { sessions: 0, devices: 1, updatedAt: 1 },
        revision: 1,
      },
      remoteRoot: active.remoteRoot,
      joinedAt: 1,
    },
  ],
}
const recoveryStore = store()
recoveryStore.values.set(
  BaiduSyncProvider.credentialAccount(active.deviceID),
  JSON.stringify({
    appKey: "app",
    secretKey: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
)
recoveryStore.values.set(
  `space:${active.namespaceID}:root`,
  Buffer.from(new Uint8Array(32).fill(1)).toString("base64url"),
)
let runtimeConstructions = 0
const unavailableProvider = (): SyncProvider.Adapter => {
  runtimeConstructions++
  const unavailable = () => Promise.reject(new Error("offline"))
  return {
    id: "memory",
    list: unavailable,
    stat: unavailable,
    download: unavailable,
    uploadAtomic: unavailable,
    deleteBatch: unavailable,
  }
}
const recoveryControlNode = {
  ...SyncControl.node,
  implementation: SyncControl.layerWith({
    secureStore: async () => recoveryStore,
    provider: unavailableProvider,
  }),
}
const recoveryControlIt = testEffect(
  LayerNode.compile(recoveryControlNode, [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
    [
      SyncSetup.node,
      Layer.mock(SyncSetup.Service, {
        state: () => Effect.succeed(encryptedState),
        config: () => Effect.succeed(encrypted),
        authenticated: () => Effect.succeed(true),
        cloudStatus: () => Effect.succeed(readyCloud),
        applyRemoteDeletion: () => Effect.succeed(false),
        join: () =>
          Effect.promise(async () => {
            await recoveryStore.set(
              `space:${active.namespaceID}:root`,
              Buffer.from(new Uint8Array(32).fill(2)).toString("base64url"),
            )
            return encryptedState
          }),
      }),
    ],
  ]),
)

let lifecycleStarted = false
let lifecycleAborted = false
let lifecycleClearedAfterAbort = false
const lifecycleStore = store()
lifecycleStore.values.set(
  BaiduSyncProvider.credentialAccount(active.deviceID),
  JSON.stringify({
    appKey: "app",
    secretKey: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
)
const lifecycleActive = { ...active, enabled: true }
const lifecycleState = {
  ...state,
  enabled: true,
  activeSpaceID: active.namespaceID,
  spaces: encryptedState.spaces.map((item) => ({
    ...item,
    descriptor: { ...item.descriptor, encryption: "none" as const },
  })),
}
const blockedProvider = (): SyncProvider.Adapter => {
  const values = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const blocked = <A>(signal?: AbortSignal) =>
    new Promise<A>((_resolve, reject) => {
      lifecycleStarted = true
      const abort = () => {
        lifecycleAborted = true
        reject(signal?.reason ?? new Error("aborted"))
      }
      if (signal?.aborted) return abort()
      signal?.addEventListener("abort", abort, { once: true })
    })
  return {
    id: "blocked",
    list: (_prefix, _cursor, signal) => blocked<SyncProvider.ListPage>(signal),
    listRecursive: (_prefix, _cursor, signal) => blocked<SyncProvider.ListPage>(signal),
    stat: async (path, signal) => {
      if (path.startsWith("devices/")) return blocked<SyncProvider.ObjectInfo | undefined>(signal)
      const value = values.get(path)
      return value ? { path, version: value.version, size: value.bytes.length } : undefined
    },
    download: async (path, version) => {
      const value = values.get(path)
      if (!value || (version && value.version !== version)) throw new Error("unexpected download")
      return { path, version: value.version, size: value.bytes.length, bytes: value.bytes.slice() }
    },
    uploadAtomic: async (path, bytes, precondition) => {
      const current = values.get(path)
      if (precondition.type === "absent" && current)
        throw new SyncProvider.ProviderError("blocked", "upload", "conflict", false)
      const version = String(++revision)
      values.set(path, { version, bytes: bytes.slice() })
      return { path, version, size: bytes.length }
    },
    deleteBatch: async () => [],
  }
}
const lifecycleControlNode = {
  ...SyncControl.node,
  implementation: SyncControl.layerWith({ secureStore: async () => lifecycleStore, provider: blockedProvider }),
}
const lifecycleControlIt = testEffect(
  LayerNode.compile(lifecycleControlNode, [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
    [
      SyncSetup.node,
      Layer.mock(SyncSetup.Service, {
        state: () => Effect.succeed(lifecycleState),
        config: () => Effect.succeed(lifecycleActive),
        setEnabled: () => Effect.succeed(lifecycleState),
        authenticated: () => Effect.succeed(true),
        cloudStatus: () => Effect.succeed(readyCloud),
        clearCloud: () =>
          Effect.sync(() => {
            lifecycleClearedAfterAbort = lifecycleAborted
            return { ...lifecycleState, enabled: false, activeSpaceID: undefined }
          }),
        applyRemoteDeletion: () => Effect.succeed(false),
      }),
    ],
  ]),
)

let bootstrapAttempts = 0
const bootstrapStore = store()
bootstrapStore.values.set(
  BaiduSyncProvider.credentialAccount(active.deviceID),
  JSON.stringify({
    appKey: "app",
    secretKey: "secret",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
)
const bootstrapState = { ...lifecycleState, enabled: false }
const bootstrapControlNode = {
  ...SyncControl.node,
  implementation: SyncControl.layerWith({ secureStore: async () => bootstrapStore, provider: unavailableProvider }),
}
const bootstrapControlIt = testEffect(
  LayerNode.compile(bootstrapControlNode, [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
    [
      SyncSetup.node,
      Layer.mock(SyncSetup.Service, {
        state: () => Effect.succeed(bootstrapState),
        config: () => Effect.succeed(active),
        authenticated: () => Effect.succeed(true),
        cloudStatus: () => Effect.succeed(readyCloud),
        initializeCloud: () => Effect.succeed(bootstrapState),
        applyRemoteDeletion: () => Effect.succeed(false),
      }),
    ],
    [
      SyncMembership.node,
      Layer.mock(SyncMembership.Service, {
        stale: () => Effect.succeed([]),
        assignAll: () =>
          Effect.suspend(() => {
            bootstrapAttempts++
            return bootstrapAttempts === 1 ? Effect.fail(new Error("crash")) : Effect.succeed(["session-local"])
          }),
      }),
    ],
  ]),
)

const legacyActive = {
  ...active,
  namespaceID: SyncRoot.LEGACY_SCOPE,
  remoteRoot: SyncRoot.REMOTE_ROOT,
  enabled: true,
}
let migrationConfig: typeof active | typeof legacyActive | undefined = legacyActive
const migrationControlIt = testEffect(
  LayerNode.compile(bootstrapControlNode, [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
    [
      SyncSetup.node,
      Layer.mock(SyncSetup.Service, {
        state: () => Effect.succeed(bootstrapState),
        config: () => Effect.succeed(migrationConfig),
        setEnabled: () =>
          Effect.sync(() => {
            if (migrationConfig) migrationConfig = { ...migrationConfig, enabled: false }
            return bootstrapState
          }),
        authenticated: () => Effect.succeed(true),
        cloudStatus: () => Effect.succeed(readyCloud),
        clearCloud: () =>
          Effect.sync(() => {
            migrationConfig = undefined
            return bootstrapState
          }),
        initializeCloud: () =>
          Effect.sync(() => {
            migrationConfig = active
            return bootstrapState
          }),
        applyRemoteDeletion: () => Effect.succeed(false),
      }),
    ],
    [
      SyncMembership.node,
      Layer.mock(SyncMembership.Service, {
        stale: () => Effect.succeed([]),
        assignAll: () => Effect.succeed([]),
      }),
    ],
  ]),
)

describe("SyncControl lifecycle policy", () => {
  test("uses the Rexd target or source device name and preserves foreign ownership", () => {
    expect(
      SyncControl.portableTargetMetadata({
        deviceID: "mac",
        deviceName: "mymac",
        lastKnownTargetName: "a100-2gpu",
      }),
    ).toEqual({ ownerDeviceID: "mac", targetLabel: "a100-2gpu" })
    expect(SyncControl.portableTargetMetadata({ deviceID: "mac", deviceName: "mymac" })).toEqual({
      ownerDeviceID: "mac",
      targetLabel: "mymac",
    })
    expect(
      SyncControl.portableTargetMetadata({
        deviceID: "windows",
        deviceName: "mywindows",
        indexed: { ownerDeviceID: "mac", targetLabel: "mymac" },
      }),
    ).toEqual({ ownerDeviceID: "mac", targetLabel: "mymac" })
  })

  realControlIt.live("keeps real local status responsive while a remote check is hung and after release", () =>
    Effect.gen(function* () {
      const control = yield* SyncControl.Service
      const scope = yield* Scope.Scope
      authenticationReads = 0
      const running = yield* control.cloudStatus().pipe(Effect.exit, Effect.forkIn(scope))
      while (!remoteStarted) yield* Effect.yieldNow

      expect((yield* control.status().pipe(Effect.timeout("250 millis"))).namespaceID).toBe(active.namespaceID)
      expect(authenticationReads).toBe(0)
      releaseRemote()
      expect((yield* Fiber.join(running))._tag).toBe("Success")
      expect((yield* control.status().pipe(Effect.timeout("250 millis"))).namespaceID).toBe(active.namespaceID)
    }),
  )

  recoveryControlIt.live("rebuilds the active encrypted runtime after a successful recovery-key import", () =>
    Effect.gen(function* () {
      runtimeConstructions = 0
      const control = yield* SyncControl.Service

      expect((yield* control.now().pipe(Effect.exit))._tag).toBe("Failure")
      expect(runtimeConstructions).toBe(1)

      yield* control.join({ namespaceID: active.namespaceID, recoveryString: "redacted-recovery" })
      expect((yield* control.now().pipe(Effect.exit))._tag).toBe("Failure")
      expect(runtimeConstructions).toBe(2)
    }),
  )

  lifecycleControlIt.live(
    "aborts and drains automatic work before clearing cloud state",
    () =>
      Effect.gen(function* () {
        lifecycleStarted = false
        lifecycleAborted = false
        lifecycleClearedAfterAbort = false
        const control = yield* SyncControl.Service

        while (!lifecycleStarted) yield* Effect.sleep("10 millis")
        yield* control.clearCloud()

        expect(lifecycleAborted).toBe(true)
        expect(lifecycleClearedAfterAbort).toBe(true)
      }),
    15_000,
  )

  migrationControlIt.live("fences legacy clear and unbound initialize during a v1 to v2 migration", () =>
    Effect.gen(function* () {
      migrationConfig = legacyActive
      const control = yield* SyncControl.Service

      yield* control.clearCloud()
      expect(migrationConfig).toBeUndefined()
      yield* control.initializeCloud()
      expect(migrationConfig?.namespaceID).toBe(active.namespaceID)
    }),
  )

  bootstrapControlIt.live("resumes an interrupted membership bootstrap exactly once", () =>
    Effect.gen(function* () {
      bootstrapAttempts = 0
      const control = yield* SyncControl.Service

      expect((yield* control.initializeCloud().pipe(Effect.exit))._tag).toBe("Failure")
      expect(bootstrapAttempts).toBe(1)

      // The cloud binding already committed. A normal retry path completes
      // the durable bootstrap before provider work, then never repeats it.
      expect((yield* control.now().pipe(Effect.exit))._tag).toBe("Failure")
      expect((yield* control.now().pipe(Effect.exit))._tag).toBe("Failure")
      expect(bootstrapAttempts).toBe(2)
    }),
  )

  test("uses plaintext without reading or creating a root key", async () => {
    const secure = store()
    const codec = await Effect.runPromise(SyncControl.codecFor({ namespaceID: "plain", encryption: "none" }, secure))
    expect(codec.mode).toBe("none")
    expect(codec.suffix).toBe(".json")
    expect(secure.reads).toBe(0)
    expect(secure.writes).toBe(0)
  })

  test("requires the secure root key only for encrypted runtime and attachment codecs", async () => {
    const secure = store()
    await expect(
      Effect.runPromise(SyncControl.codecFor({ namespaceID: "secret", encryption: "aes-256-gcm" }, secure)),
    ).rejects.toMatchObject({ kind: "locked" })
    secure.values.set("space:secret:root", Buffer.from(new Uint8Array(32).fill(7)).toString("base64url"))
    const codec = await Effect.runPromise(
      SyncControl.codecFor({ namespaceID: "secret", encryption: "aes-256-gcm" }, secure),
    )
    expect(codec.mode).toBe("aes-256-gcm")
    expect(codec.suffix).toBe(".enc")
    expect(secure.reads).toBe(2)
    expect(secure.writes).toBe(0)
  })

  test("flushes a pending outbox before switching and refuses a still-pending queue", async () => {
    let outbox = 2
    let flushes = 0
    await SyncControl.flushBeforeSwitch({
      pending: async () => outbox,
      flush: async () => {
        flushes++
        outbox = 0
      },
      force: false,
    })
    expect(flushes).toBe(1)

    await expect(
      SyncControl.flushBeforeSwitch({ pending: async () => 1, flush: async () => undefined, force: false }),
    ).resolves.toEqual({ status: "blocked", reason: "pending-outbox", outbox: 1 })
  })

  test("requires force after a failed flush but never clears the old outbox", async () => {
    let outbox = 3
    const input = {
      pending: async () => outbox,
      flush: async () => {
        throw new Error("offline")
      },
    }
    await expect(SyncControl.flushBeforeSwitch({ ...input, force: false })).resolves.toEqual({
      status: "blocked",
      reason: "pending-outbox",
      outbox: 3,
      error: "flush-failed",
    })
    await expect(SyncControl.flushBeforeSwitch({ ...input, force: true })).resolves.toBeUndefined()
    expect(outbox).toBe(3)
  })

  test("continues switching when deletion reconciliation purged the old outbox before throwing", async () => {
    let outbox = 2
    await expect(
      SyncControl.flushBeforeSwitch({
        pending: async () => outbox,
        flush: async () => {
          outbox = 0
          throw new Error("remote space deleted")
        },
        force: false,
      }),
    ).resolves.toBeUndefined()
  })

  test("forbids revoking the current device", () => {
    expect(() => SyncControl.assertCanRevoke("current", "current")).toThrow(
      expect.objectContaining({ kind: "invalid" }),
    )
    expect(() => SyncControl.assertCanRevoke("current", "other")).not.toThrow()
  })

  test("uses the active space's supported scheduler interval", () => {
    expect([30, 60, 300].map((seconds) => SyncControl.schedulerInterval(seconds as 30 | 60 | 300))).toEqual([
      30_000, 60_000, 300_000,
    ])
  })
})

function store(): SyncSecureStore.Store & {
  readonly values: Map<string, string>
  reads: number
  writes: number
} {
  const values = new Map<string, string>()
  return {
    platform: "macos-keychain",
    values,
    reads: 0,
    writes: 0,
    async get(account) {
      this.reads++
      return values.get(account)
    },
    async set(account, value) {
      this.writes++
      values.set(account, value)
    },
    async remove(account) {
      values.delete(account)
    },
  }
}
