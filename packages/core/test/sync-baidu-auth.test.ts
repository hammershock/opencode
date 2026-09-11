import { describe, expect, test } from "bun:test"
import { BaiduAuth } from "@opencode-ai/core/sync/baidu-auth"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"

function memoryStore() {
  const values = new Map<string, string>()
  return {
    platform: "macos-keychain" as const,
    values,
    get: async (account: string) => values.get(account),
    set: async (account: string, secret: string) => void values.set(account, secret),
    remove: async (account: string) => void values.delete(account),
  }
}

function provision(store: ReturnType<typeof memoryStore>) {
  store.values.set(
    SyncSecureStore.BAIDU_APP_ACCOUNT,
    JSON.stringify({ appKey: "product-app", secretKey: "app-secret" }),
  )
}

function request(accountID: string, displayName: string): BaiduSyncProvider.Request {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith("/token"))
      return Response.json({
        access_token: `access-${accountID}`,
        refresh_token: `refresh-${accountID}`,
        expires_in: 3600,
      })
    if (url.searchParams.get("method") === "uinfo")
      return Response.json({ errno: 0, uk: accountID, baidu_name: displayName })
    throw new Error(`unexpected request: ${url.origin}${url.pathname}`)
  }
}

describe("BaiduAuth", () => {
  test("bounds the account identity request after OAuth exchange", async () => {
    const store = memoryStore()
    provision(store)
    const ids = ["attempt", "state"]
    const begun = await BaiduAuth.begin({
      store,
      deviceID: "device",
      redirectURI: "oob",
      completion: "manual",
      randomUUID: () => ids.shift()!,
    })
    await expect(
      BaiduAuth.complete({
        store,
        deviceID: "device",
        attemptID: begun.attemptID,
        response: { type: "manual", code: "code" },
        requestTimeoutMs: 10,
        request: async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : input)
          if (url.pathname.endsWith("/token"))
            return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true })
          })
        },
      }),
    ).rejects.toMatchObject({ kind: "provider" })
    expect(await BaiduAuth.pending(store, "device")).toBeDefined()
  })

  test("requires product app credentials provisioned in secure storage", async () => {
    const store = memoryStore()
    await expect(
      BaiduAuth.begin({
        store,
        deviceID: "device",
        redirectURI: "http://127.0.0.1:14567/oauth/callback",
        completion: "loopback",
      }),
    ).rejects.toMatchObject({
      kind: "missing-app",
      message:
        "Baidu Netdisk is not enabled in this build. Connect your Baidu application in OpenCode Transit Sync settings.",
    })
    expect(store.values.size).toBe(0)
  })

  test("restores a pending loopback attempt after restart and validates state", async () => {
    const store = memoryStore()
    provision(store)
    const ids = ["attempt", "state"]
    const begun = await BaiduAuth.begin({
      store,
      deviceID: "device",
      redirectURI: "http://127.0.0.1:14567/oauth/callback",
      completion: "loopback",
      now: () => 100,
      randomUUID: () => ids.shift()!,
    })
    expect(begun.authorizationURL).toContain("state=state")
    const restored = await BaiduAuth.pending(store, "device", () => 101)
    expect(restored).toMatchObject({ id: "attempt", state: "state", completion: "loopback" })
    expect(BaiduAuth.loopbackCode("http://127.0.0.1:14567/oauth/callback?code=ok&state=state", restored!)).toBe("ok")
    expect(() =>
      BaiduAuth.loopbackCode("http://127.0.0.1:14567/oauth/callback?code=ok&state=wrong", restored!),
    ).toThrow("invalid-callback")
    expect(() => BaiduAuth.loopbackCode("http://127.0.0.1:9999/oauth/callback?code=ok&state=state", restored!)).toThrow(
      "invalid-callback",
    )
  })

  test("supports manual completion and persists masked account identity with the credential", async () => {
    const store = memoryStore()
    provision(store)
    const ids = ["attempt", "state"]
    const begun = await BaiduAuth.begin({
      store,
      deviceID: "device",
      redirectURI: "https://opencode.ai/oauth/baidu/manual",
      completion: "manual",
      randomUUID: () => ids.shift()!,
    })
    const identity = await BaiduAuth.complete({
      store,
      deviceID: "device",
      attemptID: begun.attemptID,
      response: { type: "manual", code: "  code  " },
      request: request("12345678", "Hammer"),
    })
    expect(identity).toEqual({ id: "12345678", displayName: "Hammer", maskedDisplay: "H•••• · ••••5678" })
    expect(await BaiduAuth.account(store, "device")).toEqual(identity)
    expect(await BaiduAuth.pending(store, "device")).toBeUndefined()
    expect(store.values.get(BaiduSyncProvider.credentialAccount("device"))).not.toContain("code")
  })

  test("accepts Baidu's installed-app out-of-band manual redirect", async () => {
    const store = memoryStore()
    provision(store)
    const ids = ["attempt", "state"]
    const begun = await BaiduAuth.begin({
      store,
      deviceID: "device",
      redirectURI: "oob",
      completion: "manual",
      randomUUID: () => ids.shift()!,
    })
    expect(new URL(begun.authorizationURL).searchParams.get("redirect_uri")).toBe("oob")
  })

  test("rejects another account during reauthentication and permits an explicit switch", async () => {
    const store = memoryStore()
    provision(store)
    await BaiduSyncProvider.saveCredential(store, "device", {
      appKey: "product-app",
      secretKey: "app-secret",
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: 10,
      account: { id: "account-a", displayName: "Alpha", maskedDisplay: "A•••• · ••••nt-a" },
    })
    const firstIDs = ["first", "state-1"]
    await BaiduAuth.begin({
      store,
      deviceID: "device",
      redirectURI: "https://opencode.ai/oauth/baidu/manual",
      completion: "manual",
      randomUUID: () => firstIDs.shift()!,
    })
    await expect(
      BaiduAuth.complete({
        store,
        deviceID: "device",
        attemptID: "first",
        response: { type: "manual", code: "code-b" },
        request: request("account-b", "Beta"),
      }),
    ).rejects.toMatchObject({ kind: "account-mismatch" })
    expect((await BaiduAuth.account(store, "device"))?.id).toBe("account-a")

    const secondIDs = ["second", "state-2"]
    await BaiduAuth.begin({
      store,
      deviceID: "device",
      redirectURI: "https://opencode.ai/oauth/baidu/manual",
      completion: "manual",
      randomUUID: () => secondIDs.shift()!,
    })
    await BaiduAuth.switchAccount({
      store,
      deviceID: "device",
      attemptID: "second",
      response: { type: "manual", code: "code-b" },
      request: request("account-b", "Beta"),
    })
    expect((await BaiduAuth.account(store, "device"))?.id).toBe("account-b")
  })
})
