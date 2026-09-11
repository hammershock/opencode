import { describe, expect, test } from "bun:test"
import { createLoopbackCallback, syncOperationFailure, withSyncRefreshTimeout } from "../../src/context/sync-settings"

describe("sync settings deployment errors", () => {
  test("maps a missing product app to an actionable message without credential terminology", () => {
    const message = syncOperationFailure(
      new Error("request failed", {
        cause: { status: 400, body: { name: "SyncSetupError", data: { kind: "missing-app" } } },
      }),
    )
    expect(message).toContain("Connect your Baidu application in OpenCode Transit Sync settings")
    expect(message).not.toContain("AppKey")
    expect(message).not.toContain("SecretKey")
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
