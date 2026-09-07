import { describe, expect, test } from "bun:test"
import { BaiduSyncProvider } from "@opencode-ai/core/sync/baidu-provider"
import { SyncProvider } from "@opencode-ai/core/sync/provider"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"

function memoryStore(initial?: BaiduSyncProvider.Credential): SyncSecureStore.Store & { values: Map<string, string> } {
  const values = new Map<string, string>()
  if (initial) values.set("baidu:device", JSON.stringify(initial))
  return {
    platform: "macos-keychain",
    values,
    get: async (account) => values.get(account),
    set: async (account, secret) => void values.set(account, secret),
    remove: async (account) => void values.delete(account),
  }
}

const credential = {
  appKey: "app-secret",
  secretKey: "client-secret",
  accessToken: "access-secret",
  refreshToken: "refresh-secret",
  expiresAt: Number.MAX_SAFE_INTEGER,
}

function listed(path: string, fsID: number, size: number, modified = 10) {
  return { path, fs_id: fsID, size, server_mtime: modified, isdir: 0 }
}

describe("BaiduSyncProvider", () => {
  test("refreshes OAuth through SecureStore and never exposes credentials", async () => {
    const store = memoryStore({ ...credential, expiresAt: 0 })
    const urls: string[] = []
    const provider = BaiduSyncProvider.adapter({
      store,
      deviceID: "device",
      root: "/apps/opencode-sync/space",
      now: () => 1_000,
      request: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input)
        urls.push(url.toString())
        if (url.hostname === "openapi.baidu.com")
          return Response.json({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 })
        return Response.json({ errno: 0, list: [], has_more: 0 })
      },
    })
    expect(await provider.stat("heads/device.enc")).toBeUndefined()
    expect((await BaiduSyncProvider.readCredential(store, "device"))?.accessToken).toBe("new-access")
    expect(urls[0]).toContain("grant_type=refresh_token")
    expect(String(await provider.stat("heads/missing.enc"))).not.toContain("secret")
  })

  test("paginates and pins downloads to an unchanged fs version", async () => {
    const store = memoryStore(credential)
    let list = 0
    let paging = true
    const provider = BaiduSyncProvider.adapter({
      store,
      deviceID: "device",
      root: "/apps/opencode-sync/space",
      request: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.hostname === "download.test") return new Response("abc")
        if (url.pathname.includes("multimedia"))
          return Response.json({ errno: 0, list: [{ dlink: "https://download.test/file" }] })
        if (url.searchParams.get("method") === "list") {
          if (!paging)
            return Response.json({
              errno: 0,
              list: [listed("/apps/opencode-sync/space/objects/1.enc", 1, 3)],
              has_more: 0,
            })
          list++
          return Response.json({
            errno: 0,
            list: [listed(`/apps/opencode-sync/space/objects/${list}.enc`, list, 3)],
            has_more: list === 1 ? 1 : 0,
          })
        }
        throw new Error("unexpected")
      },
    })
    const first = await provider.list("objects")
    expect(first.cursor).toBe("1")
    expect((await provider.list("objects", first.cursor)).cursor).toBeUndefined()
    paging = false
    const object = await provider.download("objects/1.enc", "1:10000:3")
    expect(new TextDecoder().decode(object.bytes)).toBe("abc")
    expect(object.version).toBe("1:10000:3")
  })

  test("uploads with precreate, fixed 4MiB parts, create and absence precondition", async () => {
    const store = memoryStore(credential)
    const parts: number[] = []
    let created = false
    const bytes = new Uint8Array(4 * 1024 * 1024 + 7)
    const provider = BaiduSyncProvider.adapter({
      store,
      deviceID: "device",
      root: "/apps/opencode-sync/space",
      request: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = url.searchParams.get("method")
        if (method === "list")
          return Response.json({
            errno: 0,
            list: created ? [listed("/apps/opencode-sync/space/chunks/a.enc", 9, bytes.length)] : [],
            has_more: 0,
          })
        if (method === "precreate") return Response.json({ errno: 0, uploadid: "upload-1" })
        if (url.hostname === "d.pcs.baidu.com") {
          parts.push(Number(url.searchParams.get("partseq")))
          expect((init?.body as FormData).get("file")).toBeInstanceOf(Blob)
          return Response.json({ errno: 0, md5: "part" })
        }
        if (method === "create") {
          created = true
          return Response.json({ errno: 0, ...listed("/apps/opencode-sync/space/chunks/a.enc", 9, bytes.length) })
        }
        throw new Error(`unexpected ${url}`)
      },
    })
    expect((await provider.uploadAtomic("chunks/a.enc", bytes, { type: "absent" })).size).toBe(bytes.length)
    expect(parts).toEqual([0, 1])
    await expect(provider.uploadAtomic("chunks/a.enc", bytes, { type: "absent" })).rejects.toMatchObject({
      kind: "conflict",
    })
  })

  test("verifies an unknown create outcome instead of blindly retrying", async () => {
    const store = memoryStore(credential)
    const bytes = new TextEncoder().encode("committed")
    let created = false
    let creates = 0
    const provider = BaiduSyncProvider.adapter({
      store,
      deviceID: "device",
      root: "/apps/opencode-sync/space",
      request: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input)
        const method = url.searchParams.get("method")
        if (url.hostname === "download.test") return new Response(bytes)
        if (url.pathname.includes("multimedia"))
          return Response.json({ errno: 0, list: [{ dlink: "https://download.test/file" }] })
        if (method === "list")
          return Response.json({
            errno: 0,
            list: created ? [listed("/apps/opencode-sync/space/head.enc", 4, bytes.length)] : [],
            has_more: 0,
          })
        if (method === "precreate") return Response.json({ errno: 0, uploadid: "upload-2" })
        if (url.hostname === "d.pcs.baidu.com") return Response.json({ errno: 0 })
        if (method === "create") {
          creates++
          created = true
          throw new TypeError("connection reset after commit")
        }
        throw new Error("unexpected")
      },
    })
    expect((await provider.uploadAtomic("head.enc", bytes, { type: "absent" })).version).toBe(`4:10000:${bytes.length}`)
    expect(creates).toBe(1)
  })

  test("checks versions before one batch delete and classifies throttling", async () => {
    const store = memoryStore(credential)
    const forms: string[] = []
    let throttled = true
    const provider = BaiduSyncProvider.adapter({
      store,
      deviceID: "device",
      root: "/apps/opencode-sync/space",
      sleep: async () => undefined,
      request: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.searchParams.get("method") === "list") {
          if (throttled) {
            throttled = false
            return Response.json({ errno: 31034 }, { status: 429, headers: { "retry-after": "2" } })
          }
          return Response.json({
            errno: 0,
            list: [listed("/apps/opencode-sync/space/a", 1, 2), listed("/apps/opencode-sync/space/b", 2, 2)],
            has_more: 0,
          })
        }
        if (url.searchParams.get("method") === "filemanager") {
          forms.push(String(init?.body))
          return Response.json({ errno: 0 })
        }
        throw new Error("unexpected")
      },
    })
    const result = await provider.deleteBatch([
      { path: "a", version: "1:10000:2" },
      { path: "b", version: "old" },
      { path: "missing" },
    ])
    expect(result.map((item) => item.status)).toEqual(["deleted", "conflict", "missing"])
    expect(forms).toHaveLength(1)
    expect(forms[0]).toContain("%2Fa")
    expect(forms[0]).not.toContain("%2Fb")
  })

  test("provider errors redact response bodies and tokens", async () => {
    const provider = BaiduSyncProvider.adapter({
      store: memoryStore(credential),
      deviceID: "device",
      root: "/apps/opencode-sync/space",
      request: async () => Response.json({ errno: 123, error_msg: "access-secret" }, { status: 400 }),
    })
    const failure = await provider.stat("x").catch((cause) => cause)
    expect(failure).toBeInstanceOf(SyncProvider.ProviderError)
    expect(String(failure)).not.toContain("access-secret")
  })
})
