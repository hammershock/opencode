import { describe, expect, test } from "bun:test"
import {
  createLoopbackCallback,
  syncLocalPresentation,
  syncOperationFailure,
  withSyncRefreshTimeout,
} from "../../src/context/sync-settings"

const connected = {
  account: { state: "connected" as const, maskedAccount: "a••••" },
  enabled: true,
  interval: 30 as const,
  state: "idle" as const,
  cloud: "unknown" as const,
  devices: [],
  bindings: [],
  pending: 0,
}

const state = {
  version: 2 as const,
  revision: 1,
  provider: "baidu" as const,
  deviceID: "device",
  deviceName: "Mac",
  activeSpaceID: "account-v2:instance",
  enabled: true,
  intervalSeconds: 30 as const,
  spaces: [],
}

describe("sync settings local account projection", () => {
  test("returns to the explicit connection flow when the current Auth credential is missing", () => {
    const presentation = syncLocalPresentation(connected, state)
    expect(presentation.configured).toBe(true)
    expect(presentation.model).toMatchObject({
      account: { state: "disconnected" },
      enabled: false,
      state: "off",
    })
  })

  test("keeps a matching current Auth credential connected", () => {
    expect(
      syncLocalPresentation(connected, {
        ...state,
        account: { id: "account", maskedDisplay: "a••••" },
      }).model,
    ).toMatchObject({ account: connected.account, enabled: true, state: "idle" })
  })
})

describe("sync settings credential errors", () => {
  test("maps missing application credentials to an actionable message", () => {
    const message = syncOperationFailure(
      new Error("request failed", {
        cause: { status: 400, body: { name: "SyncSetupError", data: { kind: "missing-app" } } },
      }),
    )
    expect(message).toContain("Enter your AppKey and SecretKey in OpenCode Transit Sync settings")
    expect(
      syncOperationFailure({
        cause: {
          status: 400,
          body: { name: "SyncSetupError", data: { kind: "incompatible-local-state" } },
        },
      }),
    ).toBe("Local sync state is incompatible. Archive the local sync folder and restart opencode-transit.")
    expect(syncOperationFailure({ message: "incompatible-local-state" })).toBe("Sync operation failed")
    expect(syncOperationFailure({ data: { kind: "unconfigured" } })).toBe("Cloud sync is not initialized")
    expect(syncOperationFailure({ data: { kind: "remote-uninitialized" } })).toBe("Cloud sync is not initialized")
    expect(syncOperationFailure({ data: { kind: "incompatible-remote" } })).toBe("Cloud sync protocol is incompatible")
    expect(syncOperationFailure({ data: { kind: "provider", diagnostic: { stage: "pull" } } })).toContain(
      "Sync failed during pull",
    )
    expect(syncOperationFailure({ data: { kind: "provider", diagnostic: { stage: "delete" } } })).toContain(
      "Sync failed during delete",
    )
    expect(syncOperationFailure({ data: { diagnostic: { stage: "token secret" } } })).toBe("Sync operation failed")
    expect(syncOperationFailure({ message: "provider failed with token secret" })).toBe("Sync operation failed")
  })
})

describe("sync settings OAuth loopback", () => {
  test("accepts only the callback path and responds after completion", async () => {
    const loopback = createLoopbackCallback(2_000)
    expect((await fetch(loopback.redirectURI.replace("/callback", "/other"))).status).toBe(404)

    const page = fetch(`${loopback.redirectURI}?code=abc`)
    const callback = await loopback.callback
    expect(callback?.callbackURL).toBe(`${loopback.redirectURI}?code=abc`)
    callback?.respond({ status: "success" })
    const response = await page
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("Baidu Netdisk")
    loopback.close()
  })

  test("times out without claiming authorization succeeded", async () => {
    const loopback = createLoopbackCallback(5)
    expect(await loopback.callback).toBeUndefined()
    loopback.close()
  })
})

describe("sync settings remote refresh", () => {
  test("bounds a hung provider request and aborts its signal", async () => {
    let signal: AbortSignal | undefined
    const started = performance.now()
    await expect(
      withSyncRefreshTimeout((current) => {
        signal = current
        return new Promise(() => undefined)
      }, 20),
    ).rejects.toThrow("Sync refresh timed out")
    expect(signal?.aborted).toBe(true)
    expect(performance.now() - started).toBeLessThan(250)
  })
})
