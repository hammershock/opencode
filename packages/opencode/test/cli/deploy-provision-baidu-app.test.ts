import { describe, expect, test } from "bun:test"
import type { SyncSecureStore } from "@opencode-ai/core/sync/secure-store"
import { provisionBaiduAppFromStream } from "@/cli/cmd/deploy-provision-baidu-app"

describe("hidden Baidu app deployment command", () => {
  test("accepts a bounded stdin stream through a fake store", async () => {
    const values = new Map<string, string>()
    const store: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async (account) => values.get(account),
      set: async (account, value) => void values.set(account, value),
      remove: async (account) => void values.delete(account),
    }
    async function* input() {
      yield Buffer.from('{"appKey":"dummy",')
      yield Buffer.from('"secretKey":"fake-secret"}')
    }
    await provisionBaiduAppFromStream(store, input())
    expect([...values.values()]).toEqual(['{"appKey":"dummy","secretKey":"fake-secret"}'])
  })

  test("rejects oversized stdin before touching the store", async () => {
    let touched = false
    const store: SyncSecureStore.Store = {
      platform: "macos-keychain",
      get: async () => {
        touched = true
        return undefined
      },
      set: async () => {
        touched = true
      },
      remove: async () => {
        touched = true
      },
    }
    async function* input() {
      yield Buffer.alloc(4097, 97)
    }
    await expect(provisionBaiduAppFromStream(store, input())).rejects.toThrow("Invalid Baidu app provisioning input")
    expect(touched).toBe(false)
  })
})
