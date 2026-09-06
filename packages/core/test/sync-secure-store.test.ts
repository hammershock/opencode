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
    expect(calls.every((call) => call.stdin === undefined)).toBe(true)
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
})
