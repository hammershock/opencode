import { describe, expect, test } from "bun:test"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"

describe("SyncSecureStore", () => {
  test("uses an exact macOS Keychain service without a shell", async () => {
    const calls: Array<{ operation: string; service: string; account: string; secret?: string }> = []
    const values = new Map<string, string>()
    const store = SyncSecureStore.macos(SyncSecureStore.SERVICE, {
      async get(service, account) {
        calls.push({ operation: "get", service, account })
        return values.get(account)
      },
      async set(service, account, secret) {
        calls.push({ operation: "set", service, account, secret })
        values.set(account, secret)
      },
      async remove(service, account) {
        calls.push({ operation: "remove", service, account })
        values.delete(account)
      },
    })
    await store.set("space:key", "secret")
    expect(await store.get("space:key")).toBe("secret")
    await store.remove("space:key")
    expect(calls.every((call) => call.service === SyncSecureStore.SERVICE)).toBe(true)
    expect(calls.map((call) => call.operation)).toEqual(["set", "remove"])
  })

  test("caches successful and missing macOS reads across store instances", async () => {
    const values = new Map([["present", "secret"]])
    const reads = new Map<string, number>()
    const backend: SyncSecureStore.MacosBackend = {
      get: async (_service, account) => {
        reads.set(account, (reads.get(account) ?? 0) + 1)
        return values.get(account)
      },
      set: async (_service, account, secret) => void values.set(account, secret),
      remove: async (_service, account) => void values.delete(account),
    }
    const first = SyncSecureStore.macos("cache-read-test", backend)
    const second = SyncSecureStore.macos("cache-read-test", backend)

    expect(await first.get("present")).toBe("secret")
    expect(await second.get("present")).toBe("secret")
    expect(await first.get("missing")).toBeUndefined()
    expect(await second.get("missing")).toBeUndefined()
    expect(reads).toEqual(
      new Map([
        ["present", 1],
        ["missing", 1],
      ]),
    )
  })

  test("isolates cached reads by Keychain service and account", async () => {
    const calls: string[] = []
    const backend: SyncSecureStore.MacosBackend = {
      get: async (service, account) => {
        calls.push(`${service}:${account}`)
        return `${service}:${account}:value`
      },
      set: async () => undefined,
      remove: async () => undefined,
    }
    const first = SyncSecureStore.macos("first-service", backend)
    const second = SyncSecureStore.macos("second-service", backend)

    expect(await first.get("account-a")).toBe("first-service:account-a:value")
    expect(await first.get("account-b")).toBe("first-service:account-b:value")
    expect(await second.get("account-a")).toBe("second-service:account-a:value")
    expect(await first.get("account-a")).toBe("first-service:account-a:value")
    expect(calls).toEqual(["first-service:account-a", "first-service:account-b", "second-service:account-a"])
  })

  test("coalesces concurrent macOS reads and does not cache failures", async () => {
    let release = (_value: string | undefined) => {}
    let calls = 0
    let fail = false
    const backend: SyncSecureStore.MacosBackend = {
      get: async () => {
        calls++
        if (fail) throw new SyncSecureStore.SecureStoreOperationError("fake failure")
        return new Promise<string | undefined>((resolve) => void (release = resolve))
      },
      set: async () => undefined,
      remove: async () => undefined,
    }
    const store = SyncSecureStore.macos("cache-coalesce-test", backend)
    const first = store.get("account")
    const second = store.get("account")
    await Bun.sleep(0)
    expect(calls).toBe(1)
    release("secret")
    expect(await Promise.all([first, second])).toEqual(["secret", "secret"])

    fail = true
    await expect(store.get("failure")).rejects.toThrow("fake failure")
    await expect(store.get("failure")).rejects.toThrow("fake failure")
    expect(calls).toBe(3)
  })

  test("keeps cached macOS reads coherent after product set and remove", async () => {
    const values = new Map([["account", "old"]])
    let reads = 0
    const backend: SyncSecureStore.MacosBackend = {
      get: async (_service, account) => {
        reads++
        return values.get(account)
      },
      set: async (_service, account, secret) => void values.set(account, secret),
      remove: async (_service, account) => void values.delete(account),
    }
    const store = SyncSecureStore.macos("cache-mutation-test", backend)
    expect(await store.get("account")).toBe("old")
    await store.set("account", "new")
    expect(await store.get("account")).toBe("new")
    await store.remove("account")
    expect(await store.get("account")).toBeUndefined()
    expect(reads).toBe(1)
  })

  test("passes long UTF-8 macOS secrets only to the native backend", async () => {
    const secret = `credential-${"汉字".repeat(100)}`
    let written: string | undefined
    const store = SyncSecureStore.macos("opencode-rexd-sync-test", {
      get: async () => undefined,
      set: async (_service, _account, value) => void (written = value),
      remove: async () => undefined,
    })
    await store.set("long-secret", secret)
    expect(Buffer.byteLength(secret, "utf8")).toBeGreaterThan(128)
    expect(written).toBe(secret)
  })

  test("passes PasswordVault secrets over stdin and recovers WSL interop for tmux", async () => {
    const calls: Array<{ command: readonly string[]; stdin?: string; env?: Record<string, string> }> = []
    const store = SyncSecureStore.windowsVault(
      async (command, stdin, env) => {
        calls.push({ command, stdin, env })
        return { exitCode: 0, stdout: "vault-value", stderr: "" }
      },
      async () => "/run/WSL/123_interop",
    )
    await store.set("space:key", "vault-value")
    expect(await store.get("space:key")).toBe("vault-value")
    expect(calls[0]!.command.join(" ")).not.toContain("vault-value")
    expect(calls[0]!.stdin).toContain('"secret":"vault-value"')
    if (!process.env.WSL_INTEROP) expect(calls[0]!.env?.WSL_INTEROP).toBe("/run/WSL/123_interop")
  })

  test("replaces a stale inherited WSL interop before invoking PasswordVault", async () => {
    const previous = process.env.WSL_INTEROP
    process.env.WSL_INTEROP = "/run/WSL/stale_interop"
    const calls: Array<{ stdin?: string; env?: Record<string, string> }> = []
    const store = SyncSecureStore.windowsVault(
      async (_command, stdin, env) => {
        calls.push({ stdin, env })
        return { exitCode: 0, stdout: "vault-value", stderr: "" }
      },
      async () => "/run/WSL/live_interop",
    )
    try {
      expect(await store.get("space:key")).toBe("vault-value")
      expect(calls).toHaveLength(1)
      expect(calls[0]!.env).toEqual({ WSL_INTEROP: "/run/WSL/live_interop" })
      expect(calls[0]!.stdin).not.toContain("stale_interop")
    } finally {
      if (previous === undefined) delete process.env.WSL_INTEROP
      else process.env.WSL_INTEROP = previous
    }
  })

  test("retries once when WSL interop changes after a transport failure", async () => {
    const previous = process.env.WSL_INTEROP
    process.env.WSL_INTEROP = "/run/WSL/old_interop"
    const calls: Array<{ stdin?: string; env?: Record<string, string> }> = []
    const discovered = ["/run/WSL/old_interop", "/run/WSL/new_interop"]
    const store = SyncSecureStore.windowsVault(
      async (_command, stdin, env) => {
        calls.push({ stdin, env })
        return calls.length === 1
          ? { exitCode: 1, stdout: "", stderr: "transport failed" }
          : { exitCode: 0, stdout: "vault-value", stderr: "" }
      },
      async () => discovered.shift(),
    )
    try {
      expect(await store.get("space:key")).toBe("vault-value")
      expect(calls).toHaveLength(2)
      expect(calls[0]!.env).toEqual({})
      expect(calls[1]!.env).toEqual({ WSL_INTEROP: "/run/WSL/new_interop" })
      expect(calls[0]!.stdin).toBe(calls[1]!.stdin)
    } finally {
      if (previous === undefined) delete process.env.WSL_INTEROP
      else process.env.WSL_INTEROP = previous
    }
  })

  test("does not retry a semantic missing PasswordVault record", async () => {
    let calls = 0
    const store = SyncSecureStore.windowsVault(
      async () => {
        calls++
        return { exitCode: 3, stdout: "", stderr: "" }
      },
      async () => `/run/WSL/${calls + 1}_interop`,
    )
    expect(await store.get("missing")).toBeUndefined()
    expect(calls).toBe(1)
  })

  test("maps missing records and redacts platform failures", async () => {
    const missing = SyncSecureStore.macos("test", {
      get: async () => undefined,
      set: async () => undefined,
      remove: async () => undefined,
    })
    expect(await missing.get("missing")).toBeUndefined()
    const broken = SyncSecureStore.macos("test", {
      get: async () => {
        throw new SyncSecureStore.SecureStoreOperationError("Keychain status -1")
      },
      set: async () => undefined,
      remove: async () => undefined,
    })
    await expect(broken.get("broken")).rejects.toThrow("status -1")
    await expect(broken.get("broken")).rejects.not.toThrow("secret leak")
  })

  test("refuses unsupported hosts", async () => {
    await expect(SyncSecureStore.detect({ platform: "linux", procVersion: "Linux generic" })).rejects.toBeInstanceOf(
      SyncSecureStore.SecureStoreUnavailableError,
    )
  })

  test("reads deployment-provisioned Baidu app credentials from the secure store", async () => {
    const values = new Map([
      [SyncSecureStore.BAIDU_APP_ACCOUNT, JSON.stringify({ appKey: "app", secretKey: "secret" })],
    ])
    const secure: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async (account) => values.get(account),
      set: async (account, secret) => void values.set(account, secret),
      remove: async (account) => void values.delete(account),
    }
    expect(await SyncSecureStore.readProvisionedBaiduApp(secure)).toEqual({ appKey: "app", secretKey: "secret" })
    expect([...values.keys()]).toEqual([SyncSecureStore.BAIDU_APP_ACCOUNT])
  })

  test("provisions the exact app account and verifies the write", async () => {
    const values = new Map<string, string>()
    const secure: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async (account) => values.get(account),
      set: async (account, secret) => void values.set(account, secret),
      remove: async (account) => void values.delete(account),
    }
    await SyncSecureStore.provisionBaiduApp(secure, JSON.stringify({ appKey: "app", secretKey: "secret" }))
    expect(values.get(SyncSecureStore.BAIDU_APP_ACCOUNT)).toBe('{"appKey":"app","secretKey":"secret"}')
  })

  test("rejects unbounded or expanded deployment envelopes before writing", async () => {
    let writes = 0
    const secure: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async () => undefined,
      set: async () => void writes++,
      remove: async () => undefined,
    }
    await expect(
      SyncSecureStore.provisionBaiduApp(
        secure,
        JSON.stringify({ appKey: "app", secretKey: "secret", accessToken: "must-not-be-accepted" }),
      ),
    ).rejects.toThrow("Invalid Baidu app provisioning input")
    await expect(
      SyncSecureStore.provisionBaiduApp(secure, JSON.stringify({ appKey: "a".repeat(513), secretKey: "secret" })),
    ).rejects.toThrow("Invalid Baidu app provisioning input")
    expect(writes).toBe(0)
  })

  test("restores the previous app credential when verification fails", async () => {
    const previous = '{"appKey":"old","secretKey":"old-secret"}'
    let value = previous
    let corruptNextWrite = true
    const secure: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async () => value,
      set: async (_account, secret) => {
        value = corruptNextWrite ? "corrupt" : secret
        corruptNextWrite = false
      },
      remove: async () => {
        value = ""
      },
    }
    await expect(
      SyncSecureStore.provisionBaiduApp(secure, JSON.stringify({ appKey: "new", secretKey: "new-secret" })),
    ).rejects.toThrow("previous credential was restored")
    expect(value).toBe(previous)
  })

  test.skipIf(process.env.OPENCODE_REAL_SECURE_STORE !== "1")(
    "round trips a disposable record through the host secure store",
    async () => {
      const store =
        process.platform === "darwin"
          ? SyncSecureStore.macos(`opencode-rexd-sync-acceptance-${crypto.randomUUID()}`)
          : await SyncSecureStore.detect()
      const account = `long-secret-${crypto.randomUUID()}`
      const secret = `nonsecret-${"roundtrip".repeat(40)}`
      try {
        await store.set(account, "nonsecret-before-update")
        await store.set(account, secret)
        expect(Buffer.byteLength(secret, "utf8")).toBeGreaterThan(128)
        expect(await store.get(account)).toBe(secret)
      } finally {
        await store.remove(account)
        expect(await store.get(account)).toBeUndefined()
      }
    },
  )
})
