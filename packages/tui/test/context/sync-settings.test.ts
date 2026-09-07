import { describe, expect, test } from "bun:test"
import { createLoopbackCallback, syncOperationFailure, unassignedFingerprint } from "../../src/context/sync-settings"

describe("sync settings deployment errors", () => {
  test("maps a missing product app to an actionable message without credential terminology", () => {
    const message = syncOperationFailure(
      new Error("request failed", {
        cause: { status: 400, body: { name: "SyncSetupError", data: { kind: "missing-app" } } },
      }),
    )
    expect(message).toContain("Reinstall an official opencode-rexd build")
    expect(message).not.toContain("AppKey")
    expect(message).not.toContain("SecretKey")
    expect(
      syncOperationFailure({
        cause: {
          status: 400,
          body: { name: "SyncSetupError", data: { kind: "incompatible-local-state" } },
        },
      }),
    ).toBe("Local sync state is incompatible. Archive the local sync folder and restart opencode-rexd.")
    expect(syncOperationFailure({ message: "incompatible-local-state" })).toBe("Sync operation failed")
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

describe("unassigned Session prompt identity", () => {
  test("is stable by ID order and isolated by active space", () => {
    expect(unassignedFingerprint("space-a", ["session-b", "session-a"])).toBe(
      unassignedFingerprint("space-a", ["session-a", "session-b"]),
    )
    expect(unassignedFingerprint("space-a", ["session-a"])).not.toBe(unassignedFingerprint("space-b", ["session-a"]))
  })
})
