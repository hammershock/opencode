import { describe, expect, test } from "bun:test"
import { Effect, Fiber, Layer, Scope } from "effect"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { Database } from "@opencode-ai/core/database/database"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { testEffect } from "./lib/effect"

let remoteStarted = false
let releaseRemote = () => {}
const active = {
  provider: "baidu" as const,
  deviceID: "device",
  deviceName: "Mac",
  account: { id: "account", maskedDisplay: "acc***" },
  namespaceID: "space",
  name: "Space",
  encryption: "none" as const,
  remoteRoot: "/apps/opencode-sync/spaces/space",
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
const realControlIt = testEffect(
  LayerNode.compile(SyncControl.node, [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
    [
      SyncSetup.node,
      Layer.mock(SyncSetup.Service, {
        state: () => Effect.succeed(state),
        config: () => Effect.succeed(active),
        authenticated: () => Effect.succeed(true),
        applyRemoteDeletion: () =>
          Effect.promise(
            () =>
              new Promise<boolean>((resolve) => {
                remoteStarted = true
                releaseRemote = () => resolve(false)
              }),
          ).pipe(Effect.andThen(Effect.fail(new SyncSetup.SetupError({ kind: "remote" })))),
      }),
    ],
  ]),
)

describe("SyncControl lifecycle policy", () => {
  realControlIt.live("keeps real local status responsive while a remote check is hung and after release", () =>
    Effect.gen(function* () {
      const control = yield* SyncControl.Service
      const scope = yield* Scope.Scope
      const running = yield* control.now().pipe(Effect.exit, Effect.forkIn(scope))
      while (!remoteStarted) yield* Effect.yieldNow

      expect((yield* control.status().pipe(Effect.timeout("250 millis"))).namespaceID).toBe(active.namespaceID)
      releaseRemote()
      expect((yield* Fiber.join(running))._tag).toBe("Failure")
      expect((yield* control.status().pipe(Effect.timeout("250 millis"))).namespaceID).toBe(active.namespaceID)
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
