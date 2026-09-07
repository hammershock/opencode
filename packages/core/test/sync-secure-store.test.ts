import { describe, expect, test } from "bun:test"
import { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"

describe("SyncSecureStore", () => {
  test("uses an exact macOS Keychain service without a shell", async () => {
    const calls: Array<{ command: readonly string[]; stdin?: string }> = []
    const store = SyncSecureStore.macos(async (command, stdin) => {
      calls.push({ command, stdin })
      if (command[1] === "find-generic-password") return { exitCode: 0, stdout: "secret\n", stderr: "" }
      return { exitCode: 0, stdout: "", stderr: "" }
    })
    await store.set("space:key", "secret")
    expect(await store.get("space:key")).toBe("secret")
    await store.remove("space:key")
    expect(calls.every((call) => call.command[0] === "/usr/bin/security")).toBe(true)
    expect(calls.every((call) => call.command.includes(SyncSecureStore.SERVICE))).toBe(true)
    const write = calls.find((call) => call.command.includes("add-generic-password"))!
    expect(write.command.at(-1)).toBe("-w")
    expect(write.command.join(" ")).not.toContain("secret")
    expect(write.stdin).toBe("secret\nsecret\n")
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

  test("maps missing records and redacts platform failures", async () => {
    const missing = SyncSecureStore.macos(async () => ({ exitCode: 44, stdout: "", stderr: "secret leak" }))
    expect(await missing.get("missing")).toBeUndefined()
    const broken = SyncSecureStore.macos(async () => ({ exitCode: 9, stdout: "", stderr: "secret leak" }))
    await expect(broken.get("broken")).rejects.toThrow("exit code 9")
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
      const store = await SyncSecureStore.detect()
      const account = `acceptance-${crypto.randomUUID()}`
      try {
        await store.set(account, "nonsecret-acceptance")
        expect(await store.get(account)).toBe("nonsecret-acceptance")
      } finally {
        await store.remove(account)
      }
    },
  )
})
