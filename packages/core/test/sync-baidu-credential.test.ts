import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Auth } from "@opencode-ai/core/auth"
import { BaiduCredential } from "@opencode-ai/core/sync/baidu-credential"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"

function authStore() {
  const values = new Map<string, Auth.Info>()
  const service: Auth.Interface = {
    get: (key) => Effect.succeed(values.get(key)),
    all: () => Effect.succeed(Object.fromEntries(values)),
    set: (key, value) => Effect.sync(() => void values.set(key, value)),
    remove: (key) => Effect.sync(() => void values.delete(key)),
  }
  return { values, store: BaiduCredential.auth(service) }
}

function legacyStore() {
  const values = new Map<string, string>()
  const store: SyncSecureStore.Store = {
    platform: "macos-keychain",
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
  return { values, store }
}

const credential = {
  appKey: "app-key",
  secretKey: "secret-key",
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: 123,
  account: { id: "account", displayName: "Hammer", maskedDisplay: "H••••" },
}

describe("BaiduCredential", () => {
  test("stores application and OAuth values in one OpenCode Auth entry", async () => {
    const auth = authStore()
    await auth.store.saveApplication({ appKey: credential.appKey, secretKey: credential.secretKey })
    expect(auth.values.get(BaiduCredential.KEY)).toMatchObject({
      type: "api",
      key: credential.secretKey,
      metadata: { appKey: credential.appKey },
    })

    await auth.store.saveCredential("device", credential)
    expect(auth.values.get(BaiduCredential.KEY)).toMatchObject({
      type: "oauth",
      access: credential.accessToken,
      refresh: credential.refreshToken,
      expires: credential.expiresAt,
      accountId: credential.account.id,
      metadata: {
        appKey: credential.appKey,
        secretKey: credential.secretKey,
        accountDisplayName: credential.account.displayName,
        accountMaskedDisplay: credential.account.maskedDisplay,
      },
    })
    expect(await auth.store.credential("another-device")).toEqual(credential)
  })

  test("imports and verifies a legacy credential without deleting its source", async () => {
    const auth = authStore()
    const legacy = legacyStore()
    legacy.values.set("baidu:device", JSON.stringify(credential))

    expect(await BaiduCredential.importLegacy(auth.store, legacy.store, "device")).toEqual(credential)
    expect(await auth.store.credential("device")).toEqual(credential)
    expect(legacy.values.get("baidu:device")).toBe(JSON.stringify(credential))
  })

  test("removes only the Transit Baidu entry", async () => {
    const auth = authStore()
    auth.values.set("anthropic", new Auth.Api({ type: "api", key: "provider-key" }))
    await auth.store.saveCredential("device", credential)
    await auth.store.remove("device")
    expect(auth.values.has(BaiduCredential.KEY)).toBe(false)
    expect(auth.values.get("anthropic")).toMatchObject({ key: "provider-key" })
  })
})
