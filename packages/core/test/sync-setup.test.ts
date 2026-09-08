import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { SyncRoot } from "@opencode-ai/core/sync/root"
import { tmpdir } from "./fixture/tmpdir"

describe("SyncSetup lifecycle", () => {
  test("preserves only the deployment-safe missing-app authentication reason", async () => {
    await using tmp = await tmpdir()
    const setup = SyncSetup.make({ configDirectory: tmp.path, store: store() })
    await run(setup.initialize("Mac"))
    await expect(run(setup.begin(manual))).rejects.toMatchObject({ kind: "missing-app" })
  })

  test("rejects unsupported local state without mutation or secure-store access", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const setup = SyncSetup.make({ configDirectory: tmp.path, store: secure })
    await run(setup.initialize("Mac"))
    const filename = `${tmp.path}/sync/config.json`
    const legacy = '{"version":1,"deviceID":"legacy-device","credential":"must-not-be-read"}\n'
    await Bun.write(filename, legacy)
    secure.reads = 0

    await expect(run(setup.state())).rejects.toMatchObject({ kind: "incompatible-local-state" })
    await expect(run(setup.initialize("Mac"))).rejects.toMatchObject({ kind: "incompatible-local-state" })
    await expect(run(setup.begin(manual))).rejects.toMatchObject({ kind: "incompatible-local-state" })
    expect(secure.reads).toBe(0)
    expect(await Bun.file(filename).text()).toBe(legacy)
  })

  test("reads config without secure storage and login survives restart without creating a space", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    provision(secure)
    const ids = ["device", "attempt", "state"]
    const first = SyncSetup.make({
      configDirectory: tmp.path,
      store: secure,
      randomUUID: () => ids.shift()!,
      request: authRequest("account-a"),
    })
    await run(first.initialize("Mac"))
    secure.reads = 0
    expect(await run(first.state())).toMatchObject({ deviceID: "device", spaces: [] })
    expect(await run(first.config())).toBeUndefined()
    expect(secure.reads).toBe(0)
    const begun = await run(first.begin(manual))

    const restarted = SyncSetup.make({ configDirectory: tmp.path, store: secure, request: authRequest("account-a") })
    const loggedIn = await run(
      restarted.complete({ attemptID: begun.attemptID, response: { type: "manual", code: "code" } }),
    )
    expect(loggedIn).toMatchObject({ account: { id: "account-a" }, spaces: [], activeSpaceID: undefined })
    expect(await run(restarted.config())).toBeUndefined()
  })

  test("initializes and clears one account-wide cloud root without preserving legacy spaces", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const setup = await authenticated(tmp.path, secure, provider, () => key("legacy"))
    await run(setup.create({ name: "Legacy" }))
    await run(setup.setEnabled(true))
    expect((await run(setup.cloudStatus())).status).toBe("uninitialized")

    const initialized = await run(setup.initializeCloud())
    expect(initialized.enabled).toBeFalse()
    expect(initialized.activeSpaceID).toBe(SyncRoot.INTERNAL_SCOPE)
    expect(initialized.spaces.map((item) => item.descriptor.namespaceID)).toEqual([SyncRoot.INTERNAL_SCOPE])
    expect((await run(setup.cloudStatus())).status).toBe("ready")
    expect(await provider.stat("manifest.json")).toBeDefined()

    await run(setup.setEnabled(true))
    const cleared = await run(setup.clearCloud())
    expect(cleared.enabled).toBeFalse()
    expect(cleared.activeSpaceID).toBeUndefined()
    expect(await provider.stat("manifest.json")).toBeUndefined()
  })

  test("creates, binds and activates plain or encrypted spaces with immutable key handling", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const keys = [key("plain"), key("secret")]
    const setup = await authenticated(tmp.path, secure, provider, () => keys.shift()!)
    const plain = await run(setup.create({ name: "Plain" }))
    expect(plain.recoveryString).toBeUndefined()
    expect(secure.values.has("space:plain:root")).toBe(false)
    const encrypted = await run(setup.create({ name: "Secret", encryption: "aes-256-gcm" }))
    expect(encrypted.recoveryString).toStartWith("ocr1.")
    expect(secure.values.has("space:secret:root")).toBe(true)
    expect((await run(setup.discover())).spaces).toHaveLength(2)

    expect((await run(setup.activate("plain"))).activeSpaceID).toBe("plain")
    expect(await run(setup.config())).toMatchObject({ namespaceID: "plain", encryption: "none" })
    expect((await run(setup.setInterval(300))).intervalSeconds).toBe(300)
    expect((await run(setup.setEnabled(false))).enabled).toBe(false)
    const left = await run(setup.leave("plain"))
    expect(left.activeSpaceID).toBeUndefined()
    expect(left.spaces.map((item) => item.descriptor.namespaceID)).toEqual(["secret"])
    expect((await run(setup.leave("secret"))).spaces).toEqual([])
    expect(secure.values.has("space:secret:root")).toBe(false)
  })

  test("joins plain spaces without keys and requires the matching recovery key for encrypted spaces", async () => {
    await using ownerDir = await tmpdir()
    await using joinerDir = await tmpdir()
    const provider = memoryProvider()
    const ownerStore = store()
    const owner = await authenticated(ownerDir.path, ownerStore, provider, () => key("encrypted"))
    const created = await run(owner.create({ name: "Encrypted", encryption: "aes-256-gcm" }))
    const joinerStore = store()
    const joiner = await authenticated(joinerDir.path, joinerStore, provider)
    await expect(run(joiner.join({ namespaceID: "encrypted" }))).rejects.toMatchObject({ kind: "locked" })
    await expect(
      run(
        joiner.join({ namespaceID: "encrypted", recoveryString: await SyncCrypto.exportRecoveryString(key("other")) }),
      ),
    ).rejects.toMatchObject({ kind: "locked" })
    const joined = await run(joiner.join({ namespaceID: "encrypted", recoveryString: created.recoveryString }))
    expect(joined.spaces[0]?.descriptor.namespaceID).toBe("encrypted")
    expect(joinerStore.values.has("space:encrypted:root")).toBe(true)
  })

  test("keeps account mismatch strict and explicit switching clears account-scoped bindings", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const setup = await authenticated(tmp.path, secure, provider, () => key("space"))
    await run(setup.create({ name: "Space" }))
    await run(setup.activate("space"))
    const other = SyncSetup.make({
      configDirectory: tmp.path,
      store: secure,
      provider,
      request: authRequest("account-b"),
    })
    const begun = await run(other.begin(manual))
    const response = { attemptID: begun.attemptID, response: { type: "manual" as const, code: "code" } }
    await expect(run(other.complete(response))).rejects.toMatchObject({ kind: "account-mismatch" })
    expect((await run(setup.state()))?.account?.id).toBe("account-a")
    const switchAttempt = await run(other.begin(manual))
    const switched = await run(
      other.switchAccount({
        attemptID: switchAttempt.attemptID,
        response: { type: "manual", code: "code" },
      }),
    )
    expect(switched.account?.id).toBe("account-b")
    expect(switched.spaces).toHaveLength(0)
    expect(switched.activeSpaceID).toBeUndefined()
  })

  test("logout removes OAuth and disables while preserving metadata, bindings, keys and ownership-facing state", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const setup = await authenticated(tmp.path, secure, memoryProvider(), () => key("secret"))
    await run(setup.create({ name: "Secret", encryption: "aes-256-gcm" }))
    await run(setup.activate("secret"))
    const loggedOut = await run(setup.logout())
    expect(loggedOut).toMatchObject({ enabled: false, account: { id: "account-a" } })
    expect(loggedOut.activeSpaceID).toBeUndefined()
    expect(loggedOut.spaces).toHaveLength(1)
    expect(secure.values.has(BaiduSyncProvider.credentialAccount("device"))).toBe(false)
    expect(secure.values.has("space:secret:root")).toBe(true)
    await expect(run(setup.discover())).rejects.toMatchObject({ kind: "unauthenticated" })
  })

  test("global delete is remote-first, clears the local binding and key, and returns its Session unassignment ID", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const setup = await authenticated(tmp.path, secure, provider, () => key("secret"))
    await run(setup.create({ name: "Secret", encryption: "aes-256-gcm" }))
    await run(setup.activate("secret"))
    expect(await run(setup.deleteSpace("secret"))).toBe("secret")
    expect((await run(setup.state()))?.spaces).toEqual([])
    expect(secure.values.has("space:secret:root")).toBe(false)
    expect(await provider.stat("deleted-spaces/secret.json")).toBeDefined()
  })

  test("does not clear local state when the permanent remote delete marker cannot be published", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const base = memoryProvider()
    const setup = await authenticated(tmp.path, secure, base, () => key("kept"))
    await run(setup.create({ name: "Kept", encryption: "aes-256-gcm" }))
    const failing: SyncProvider.Adapter = {
      ...base,
      uploadAtomic: async (path, bytes, condition, signal) => {
        if (path.startsWith("deleted-spaces/")) throw new Error("offline")
        return base.uploadAtomic(path, bytes, condition, signal)
      },
    }
    const offline = SyncSetup.make({ configDirectory: tmp.path, store: secure, provider: failing })
    await expect(run(offline.deleteSpace("kept"))).rejects.toMatchObject({ kind: "remote" })
    expect((await run(offline.state()))?.spaces).toHaveLength(1)
    expect(secure.values.has("space:kept:root")).toBe(true)
  })

  test("commits local deletion after the remote tombstone even when root-key cleanup fails", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const setup = await authenticated(tmp.path, secure, provider, () => key("deleted"))
    await run(setup.create({ name: "Deleted", encryption: "aes-256-gcm" }))
    await run(setup.activate("deleted"))
    const failingStore: SyncSecureStore.Store = {
      ...secure,
      remove: async (account) => {
        if (account === "space:deleted:root") throw new Error("fake key cleanup failure")
        return secure.remove(account)
      },
    }
    const retry = SyncSetup.make({ configDirectory: tmp.path, store: failingStore, provider })

    expect(await run(retry.deleteSpace("deleted"))).toBe("deleted")
    expect((await run(retry.state()))?.spaces).toEqual([])
    expect(await provider.stat("deleted-spaces/deleted.json")).toBeDefined()
    expect(secure.values.has("space:deleted:root")).toBe(true)
  })

  test("applies a remote deletion marker locally before the active runtime can upload its old outbox", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const setup = await authenticated(tmp.path, secure, provider, () => key("remote-gone"))
    await run(setup.create({ name: "Remote gone", encryption: "aes-256-gcm" }))
    await run(setup.activate("remote-gone"))
    await provider.uploadAtomic(
      "deleted-spaces/remote-gone.json",
      new TextEncoder().encode(JSON.stringify({ namespaceID: "remote-gone", deletedAt: 20, revision: 1 })),
      { type: "absent" },
    )

    expect(await run(setup.applyRemoteDeletion("remote-gone"))).toBe(true)
    expect((await run(setup.state()))?.spaces).toEqual([])
    expect(await run(setup.config())).toBeUndefined()
    expect(secure.values.has("space:remote-gone:root")).toBe(false)
  })

  test("full device removal returns every bound ID and clears OAuth, config and keys without remote deletion", async () => {
    await using tmp = await tmpdir()
    const secure = store()
    const provider = memoryProvider()
    const keys = [key("one"), key("two")]
    const setup = await authenticated(tmp.path, secure, provider, () => keys.shift()!)
    await run(setup.create({ name: "One", encryption: "aes-256-gcm" }))
    await run(setup.create({ name: "Two", encryption: "aes-256-gcm" }))
    expect(await run(setup.removeFromDevice())).toEqual(["one", "two"])
    expect(await run(setup.state())).toBeUndefined()
    expect(secure.values.has("space:one:root")).toBe(false)
    expect(secure.values.has("space:two:root")).toBe(false)
    expect(await provider.stat("catalog/one.json")).toBeDefined()
    expect(await provider.stat("deleted-spaces/one.json")).toBeUndefined()
  })
})

const manual = { redirectURI: "https://opencode.ai/oauth/baidu/manual", completion: "manual" as const }
const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

async function authenticated(
  directory: string,
  secure: ReturnType<typeof store>,
  provider: SyncProvider.Adapter,
  createSpace?: () => SyncCrypto.SpaceKey,
) {
  provision(secure)
  const ids = ["device", "attempt", "state"]
  const setup = SyncSetup.make({
    configDirectory: directory,
    store: secure,
    provider,
    createSpace,
    randomUUID: () => ids.shift()!,
    request: authRequest("account-a"),
    now: () => 10,
  })
  await run(setup.initialize("Mac"))
  const begun = await run(setup.begin(manual))
  await run(setup.complete({ attemptID: begun.attemptID, response: { type: "manual", code: "code" } }))
  return setup
}

function store() {
  const values = new Map<string, string>()
  return {
    platform: "macos-keychain" as const,
    values,
    reads: 0,
    async get(account: string) {
      this.reads++
      return values.get(account)
    },
    async set(account: string, value: string) {
      values.set(account, value)
    },
    async remove(account: string) {
      values.delete(account)
    },
  }
}

function provision(secure: ReturnType<typeof store>) {
  secure.values.set(SyncSecureStore.BAIDU_APP_ACCOUNT, JSON.stringify({ appKey: "app", secretKey: "secret" }))
}

function authRequest(accountID: string): BaiduSyncProvider.Request {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith("/token"))
      return Response.json({ access_token: `access-${accountID}`, refresh_token: "refresh", expires_in: 3600 })
    if (url.searchParams.get("method") === "uinfo")
      return Response.json({ errno: 0, uk: accountID, baidu_name: accountID })
    throw new Error(`unexpected request: ${url}`)
  }
}

function key(namespaceID: string): SyncCrypto.SpaceKey {
  return { namespaceID, rootKey: new Uint8Array(32).fill(namespaceID.length) }
}

function memoryProvider(): SyncProvider.Adapter {
  const objects = new Map<string, { version: string; bytes: Uint8Array }>()
  let revision = 0
  const conflict = (operation: "download" | "upload") =>
    new SyncProvider.ProviderError("memory", operation, "conflict", false)
  return {
    id: "memory",
    async list(prefix) {
      return {
        objects: [...objects.entries()]
          .filter(([path]) => path === prefix || path.startsWith(`${prefix}/`))
          .map(([path, value]) => ({ path, version: value.version, size: value.bytes.length })),
      }
    },
    async stat(path) {
      const value = objects.get(path)
      return value ? { path, version: value.version, size: value.bytes.length } : undefined
    },
    async download(path, version) {
      const value = objects.get(path)
      if (!value) throw new SyncProvider.ProviderError("memory", "download", "not-found", false)
      if (version && value.version !== version) throw conflict("download")
      return { path, version: value.version, size: value.bytes.length, bytes: value.bytes.slice() }
    },
    async uploadAtomic(path, bytes, condition) {
      const current = objects.get(path)
      if (condition.type === "absent" && current) throw conflict("upload")
      if (condition.type === "version" && current?.version !== condition.version) throw conflict("upload")
      const value = { version: String(++revision), bytes: bytes.slice() }
      objects.set(path, value)
      return { path, version: value.version, size: value.bytes.length }
    },
    async deleteBatch(values) {
      return values.map((value) => {
        const current = objects.get(value.path)
        if (!current) return { path: value.path, status: "missing" as const }
        if (value.version && current.version !== value.version)
          return { path: value.path, status: "conflict" as const, version: current.version }
        objects.delete(value.path)
        return { path: value.path, status: "deleted" as const }
      })
    },
  }
}
