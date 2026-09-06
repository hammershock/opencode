import { describe, expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { Effect } from "effect"

function store(): SyncSecureStore.Store & { values: Map<string, string> } {
  const values = new Map<string, string>()
  return {
    platform: "macos-keychain",
    values,
    get: async (key) => values.get(key),
    set: async (key, value) => void values.set(key, value),
    remove: async (key) => void values.delete(key),
  }
}

function baidu() {
  const files = new Map<string, { bytes: Uint8Array; id: number; time: number }>()
  const parts = new Map<string, Uint8Array[]>()
  let next = 1
  const request: BaiduSyncProvider.Request = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const method = url.searchParams.get("method")
    if (url.hostname === "openapi.baidu.com")
      return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
    if (url.hostname === "download.test") return new Response(files.get(url.searchParams.get("path")!)?.bytes)
    if (url.pathname.includes("multimedia")) {
      const id = Number(JSON.parse(url.searchParams.get("fsids")!)[0])
      const entry = [...files.entries()].find(([, value]) => value.id === id)
      return Response.json({
        errno: 0,
        list: entry ? [{ dlink: `https://download.test/file?path=${encodeURIComponent(entry[0])}` }] : [],
      })
    }
    if (method === "list") {
      const directory = url.searchParams.get("dir")!
      return Response.json({
        errno: 0,
        has_more: 0,
        list: [...files.entries()].flatMap(([file, value]) =>
          path.posix.dirname(file) === directory
            ? [{ path: file, fs_id: value.id, size: value.bytes.length, server_mtime: value.time, isdir: 0 }]
            : [],
        ),
      })
    }
    if (method === "filemanager") {
      const form = new URLSearchParams(init?.body as URLSearchParams)
      for (const file of JSON.parse(form.get("filelist")!) as string[]) files.delete(file)
      return Response.json({ errno: 0 })
    }
    if (method === "precreate") {
      const form = new URLSearchParams(init?.body as URLSearchParams)
      parts.set(form.get("path")!, [])
      return Response.json({ errno: 0, uploadid: form.get("path") })
    }
    if (url.hostname === "d.pcs.baidu.com") {
      const form = init?.body as FormData
      const bytes = new Uint8Array(await (form.get("file") as Blob).arrayBuffer())
      parts.get(url.searchParams.get("path")!)![Number(url.searchParams.get("partseq"))] = bytes
      return Response.json({ errno: 0 })
    }
    if (method === "create") {
      const form = new URLSearchParams(init?.body as URLSearchParams)
      const file = form.get("path")!
      const bytes = Buffer.concat(parts.get(file)!.map((item) => Buffer.from(item)))
      const value = { bytes: new Uint8Array(bytes), id: next++, time: 10 }
      files.set(file, value)
      return Response.json({ errno: 0, path: file, fs_id: value.id, size: bytes.length, server_mtime: value.time })
    }
    throw new Error(`Unexpected request ${url}`)
  }
  return { request, files }
}

async function temp() {
  return fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sync-setup-"))
}

describe("SyncSetup", () => {
  test("creates an encrypted namespace without writing credentials to config", async () => {
    const configDirectory = await temp()
    const secure = store()
    const remote = baidu()
    const setup = SyncSetup.make({
      configDirectory,
      store: secure,
      legacyStore: store(),
      request: remote.request,
      now: () => 1_000,
    })
    const begin = await Effect.runPromise(setup.begin({ appKey: "app", secretKey: "secret", deviceName: "Mac" }))
    expect(begin.authorizationURL).toContain("client_id=app")
    const result = await Effect.runPromise(setup.complete({ attemptID: begin.attemptID, code: "code" }))
    expect(result.recoveryString).toStartWith("ocr1.")
    expect(remote.files.has(`${result.config.remoteRoot}/protocol.json`)).toBe(true)
    const raw = await fs.readFile(path.join(configDirectory, "sync", "config.json"), "utf8")
    expect(raw).not.toContain("secret")
    expect(raw).not.toContain("access")
    expect(secure.values.has(`space:${result.config.namespaceID}:root`)).toBe(true)
    expect(secure.values.has(`baidu:${result.config.deviceID}`)).toBe(true)
    expect((await Effect.runPromise(setup.setEnabled(false))).enabled).toBe(false)
    expect((await Effect.runPromise(setup.config()))?.enabled).toBe(false)
    await expect(
      Effect.runPromise(setup.complete({ attemptID: begin.attemptID, code: "again" })),
    ).rejects.toMatchObject({ kind: "expired" })
  })

  test("imports a recovery string only when the remote protocol matches", async () => {
    const remote = baidu()
    const first = SyncSetup.make({
      configDirectory: await temp(),
      store: store(),
      legacyStore: store(),
      request: remote.request,
    })
    const pending = await Effect.runPromise(first.begin({ appKey: "app", secretKey: "secret", deviceName: "Mac" }))
    const created = await Effect.runPromise(first.complete({ attemptID: pending.attemptID, code: "code" }))
    const second = SyncSetup.make({
      configDirectory: await temp(),
      store: store(),
      legacyStore: store(),
      request: remote.request,
    })
    const imported = await Effect.runPromise(
      second.begin({
        appKey: "app",
        secretKey: "secret",
        deviceName: "Windows",
        recoveryString: created.recoveryString,
      }),
    )
    const completed = await Effect.runPromise(second.complete({ attemptID: imported.attemptID, code: "code" }))
    expect(completed.config.namespaceID).toBe(created.config.namespaceID)
    expect(completed.config.deviceID).not.toBe(created.config.deviceID)
  })

  test("reuses only the exact legacy device credential and leaves it intact", async () => {
    const configDirectory = await temp()
    await fs.mkdir(path.join(configDirectory, "cloud-sync"), { recursive: true })
    await fs.writeFile(
      path.join(configDirectory, "cloud-sync", "legacy-config.json"),
      JSON.stringify({ provider: "baidu", deviceID: "old-device" }),
    )
    const legacy = store()
    legacy.values.set(
      "old-device",
      JSON.stringify({ appKey: "app", secretKey: "secret", accessToken: "old", refreshToken: "refresh", expiresAt: 1 }),
    )
    legacy.values.set("unrelated", "must-not-read")
    const setup = SyncSetup.make({ configDirectory, store: store(), legacyStore: legacy, request: baidu().request })
    expect(await Effect.runPromise(setup.inspectLegacy())).toEqual({ available: true, deviceID: "old-device" })
    const result = await Effect.runPromise(setup.reuseLegacy({ deviceName: "Migrated" }))
    expect(result.config.namespaceID).toBeTruthy()
    expect(legacy.values.has("old-device")).toBe(true)
    expect(legacy.values.has("unrelated")).toBe(true)
  })

  test("does not leave local half configuration after remote initialization failure", async () => {
    const configDirectory = await temp()
    const secure = store()
    const setup = SyncSetup.make({
      configDirectory,
      store: secure,
      legacyStore: store(),
      request: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.hostname === "openapi.baidu.com")
          return Response.json({ access_token: "access", refresh_token: "refresh", expires_in: 3600 })
        throw new Error("offline")
      },
    })
    const pending = await Effect.runPromise(setup.begin({ appKey: "app", secretKey: "secret", deviceName: "Mac" }))
    await expect(
      Effect.runPromise(setup.complete({ attemptID: pending.attemptID, code: "code" })),
    ).rejects.toMatchObject({ kind: "remote" })
    expect(secure.values.size).toBe(0)
    await expect(fs.stat(path.join(configDirectory, "sync", "config.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("requires explicit reset confirmation before starting setup over an existing config", async () => {
    const configDirectory = await temp()
    await fs.mkdir(path.join(configDirectory, "sync"), { recursive: true })
    await fs.writeFile(
      path.join(configDirectory, "sync", "config.json"),
      JSON.stringify({
        version: 1,
        provider: "baidu",
        namespaceID: "existing-space",
        deviceID: "existing-device",
        deviceName: "Existing",
        enabled: true,
        intervalSeconds: 30,
        remoteRoot: "/apps/opencode-sync/existing-space",
      }),
    )
    const setup = SyncSetup.make({
      configDirectory,
      store: store(),
      legacyStore: store(),
      request: async () => {
        throw new Error("OAuth must not begin")
      },
    })
    await expect(
      Effect.runPromise(setup.begin({ appKey: "app", secretKey: "secret", deviceName: "Replacement" })),
    ).rejects.toMatchObject({ kind: "invalid" })
    await expect(Effect.runPromise(setup.reuseLegacy({ deviceName: "Replacement" }))).rejects.toMatchObject({
      kind: "invalid",
    })
  })

  test("does not touch an unavailable secure store while merely reading disabled setup state", async () => {
    const configDirectory = await temp()
    let touched = 0
    const unavailable: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async () => {
        touched++
        throw new SyncSecureStore.SecureStoreUnavailableError("unavailable")
      },
      set: async () => {
        touched++
        throw new SyncSecureStore.SecureStoreUnavailableError("unavailable")
      },
      remove: async () => {
        touched++
        throw new SyncSecureStore.SecureStoreUnavailableError("unavailable")
      },
    }
    const setup = SyncSetup.make({ configDirectory, store: unavailable, legacyStore: unavailable })
    expect(await Effect.runPromise(setup.config())).toBeUndefined()
    expect(touched).toBe(0)
  })

  test("deletes the complete old namespace before activating a reset space", async () => {
    const configDirectory = await temp()
    const secure = store()
    const remote = baidu()
    const setup = SyncSetup.make({ configDirectory, store: secure, legacyStore: store(), request: remote.request })
    const pending = await Effect.runPromise(setup.begin({ appKey: "app", secretKey: "secret", deviceName: "Mac" }))
    const first = await Effect.runPromise(setup.complete({ attemptID: pending.attemptID, code: "code" }))
    const previousProtocol = `${first.config.remoteRoot}/protocol.json`
    expect(remote.files.has(previousProtocol)).toBe(true)
    const reset = await Effect.runPromise(setup.reset())
    expect(reset.config.namespaceID).not.toBe(first.config.namespaceID)
    expect(remote.files.has(previousProtocol)).toBe(false)
    expect(remote.files.has(`${reset.config.remoteRoot}/protocol.json`)).toBe(true)
  })
})
