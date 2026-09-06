import { describe, expect, test } from "bun:test"
import { Auth } from "@/auth"
import { ProviderUsage } from "@/provider/usage"
import { ProviderUsageAdapters } from "@/provider/usage-adapters"

const api = new Auth.Api({ type: "api", key: "secret-never-log" })

describe("provider usage adapters", () => {
  test("decodes official provider fixtures and rejects schema drift", () => {
    expect(
      ProviderUsageAdapters.decodeDeepSeek({
        is_available: true,
        balance_infos: [{ currency: "CNY", total_balance: "12.50", granted_balance: "0", topped_up_balance: "12.50" }],
      })[0]?.remaining,
    ).toBe(12.5)
    expect(
      ProviderUsageAdapters.decodeMoonshot({ data: { available_balance: 8, cash_balance: 8, voucher_balance: 0 } })[0]
        ?.unit,
    ).toBe("CNY")
    expect(
      ProviderUsageAdapters.decodeMiniMax({
        remains: [{ type: "five-hour", name: "5 hour", remains: 42, total: 100 }],
      })[0]?.remaining,
    ).toBe(42)
    expect(() => ProviderUsageAdapters.decodeDeepSeek({ balance_infos: [] })).toThrow()
    expect(() => ProviderUsageAdapters.decodeMoonshot({ data: { available_balance: null } })).toThrow()
    expect(() => ProviderUsageAdapters.decodeMiniMax({ remaining: 1 })).toThrow()
  })

  test("strictly decodes Codex wham usage", () => {
    const meters = ProviderUsageAdapters.decodeWham({
      rate_limit: {
        primary_window: { used_percent: 20, reset_at: 123 },
        secondary_window: { used_percent: 40, reset_at: 456 },
      },
    })
    expect(meters.map((meter) => meter.remaining)).toEqual([80, 60])
    expect(() => ProviderUsageAdapters.decodeWham({ rate_limit: { primary_window: { used_percent: 101 } } })).toThrow()
  })

  test("maps authentication and rate limit failures without exposing credentials", async () => {
    for (const status of [401, 429]) {
      const adapter = ProviderUsageAdapters.adapters(
        async () => new Response("denied secret-never-log", { status }),
      )[0]!
      const error = await adapter.fetch({ auth: api, signal: new AbortController().signal }).catch((cause) => cause)
      expect(error).toBeInstanceOf(ProviderUsage.AdapterError)
      expect(error.kind).toBe(status === 401 ? "authentication" : "rate_limit")
      expect(JSON.stringify(error)).not.toContain(api.key)
      expect(JSON.stringify(error)).not.toContain("denied")
    }
  })

  test("ingests OpenAI rate-limit headers only for saved API credentials", async () => {
    const registry = ProviderUsageAdapters.registry(undefined, () => 1_000)
    registry.ingestOpenAI(
      api,
      new Headers({
        "x-ratelimit-limit-requests": "100",
        "x-ratelimit-remaining-requests": "80",
        "x-ratelimit-reset-requests": "2s",
      }),
    )
    const openai = registry.adapters.find((adapter) => adapter.providerID === "openai")!
    expect(openai.probe({ auth: api }).status).toBe("ready")
    const snapshot = await openai.fetch({ auth: api, signal: new AbortController().signal })
    expect(snapshot.meters[0]?.resetsAt).toBe(3_000)
    expect(openai.probe({ auth: new Auth.Api({ type: "api", key: "another" }) }).status).toBe("unsupported")
  })

  test("aborts private usage requests after the short timeout", async () => {
    const adapter = ProviderUsageAdapters.adapters(
      (_url, init) =>
        new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason))),
    ).find((item) => item.providerID === "openai")!
    const started = Date.now()
    const error = await adapter
      .fetch({
        auth: new Auth.Oauth({
          type: "oauth",
          access: "access-secret",
          refresh: "refresh-secret",
          expires: 9_999,
          accountId: "acct",
        }),
        signal: new AbortController().signal,
      })
      .catch((cause) => cause)
    expect(error).toBeInstanceOf(DOMException)
    expect(error.name).toBe("TimeoutError")
    expect(Date.now() - started).toBeLessThan(3_500)
    expect(JSON.stringify(error)).not.toContain("secret")
  }, 4_000)
})
