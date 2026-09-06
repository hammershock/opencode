import { Auth } from "@/auth"
import { ProviderUsage } from "./usage"

export * as ProviderUsageAdapters from "./usage-adapters"

export type Request = (url: string, init: RequestInit) => Promise<Response>

const TIMEOUT = 3_000

export function adapters(request: Request = fetch, now: () => number = Date.now): readonly ProviderUsage.Adapter[] {
  return registry(request, now).adapters
}

export function registry(request: Request = fetch, now: () => number = Date.now) {
  const rateLimits = openAIRateLimitStore(now)
  const values = [
    balance("deepseek", "https://api.deepseek.com/user/balance", decodeDeepSeek, request, now),
    balance("moonshotai", "https://api.moonshot.cn/v1/users/me/balance", decodeMoonshot, request, now),
    balance("minimax", "https://www.minimaxi.com/v1/token_plan/remains", decodeMiniMax, request, now),
    openAICodex(request, now, rateLimits.adapter),
  ]
  return { adapters: values, ingestOpenAI: rateLimits.ingest }
}

export const defaults = registry()

function balance(
  providerID: string,
  endpoint: string,
  decode: (input: unknown) => ProviderUsage.Meter[],
  request: Request,
  now: () => number,
): ProviderUsage.Adapter {
  return {
    providerID,
    probe: ({ auth }) => (auth.type === "api" ? { status: "ready" } : { status: "unsupported" }),
    fetch: async ({ auth, signal }) => {
      if (auth.type !== "api") throw new ProviderUsage.AdapterError({ kind: "authentication" })
      const response = await timed(request, endpoint, authHeader(auth.key), signal)
      if (response.status === 401 || response.status === 403)
        throw new ProviderUsage.AdapterError({ kind: "authentication" })
      if (response.status === 429) throw new ProviderUsage.AdapterError({ kind: "rate_limit" })
      if (!response.ok) throw new ProviderUsage.AdapterError({ kind: "network" })
      const body = await response.json().catch(() => undefined)
      return new ProviderUsage.Snapshot({
        providerID,
        fetchedAt: now(),
        source: "official_api",
        meters: decode(body),
      })
    },
  }
}

function openAICodex(request: Request, now: () => number, rateLimits: ProviderUsage.Adapter): ProviderUsage.Adapter {
  return {
    providerID: "openai",
    ttlMs: 30_000,
    probe: ({ auth }) => {
      if (auth.type === "api") return rateLimits.probe({ auth })
      return auth.type === "oauth" && auth.accountId
        ? { status: "ready", accountID: auth.accountId }
        : { status: "unsupported" }
    },
    fetch: async ({ auth, signal, accountID, scopeID }) => {
      if (auth.type === "api") return rateLimits.fetch({ auth, signal, accountID, scopeID })
      if (auth.type !== "oauth" || !auth.accountId) throw new ProviderUsage.AdapterError({ kind: "authentication" })
      const response = await timed(
        request,
        "https://chatgpt.com/backend-api/wham/usage",
        {
          headers: { Authorization: `Bearer ${auth.access}`, "ChatGPT-Account-Id": auth.accountId },
        },
        signal,
      )
      if (response.status === 401 || response.status === 403)
        throw new ProviderUsage.AdapterError({ kind: "authentication" })
      if (response.status === 429) throw new ProviderUsage.AdapterError({ kind: "rate_limit" })
      if (!response.ok) throw new ProviderUsage.AdapterError({ kind: "network" })
      return new ProviderUsage.Snapshot({
        providerID: "openai",
        accountID: auth.accountId,
        fetchedAt: now(),
        source: "experimental_private",
        meters: decodeWham(await response.json().catch(() => undefined)),
      })
    },
  }
}

function authHeader(key: string): RequestInit {
  return { headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" } }
}

async function timed(request: Request, url: string, init: RequestInit, external: AbortSignal) {
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(new DOMException("Usage request timed out", "TimeoutError")),
    TIMEOUT,
  )
  const abort = () => controller.abort(external.reason)
  external.addEventListener("abort", abort, { once: true })
  return request(url, { ...init, signal: controller.signal }).finally(() => {
    clearTimeout(timeout)
    external.removeEventListener("abort", abort)
  })
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new ProviderUsage.AdapterError({ kind: "schema" })
  return input as Record<string, unknown>
}

function finite(input: unknown) {
  const value = typeof input === "string" && input.trim() ? Number(input) : input
  if (typeof value !== "number" || !Number.isFinite(value)) throw new ProviderUsage.AdapterError({ kind: "schema" })
  return value
}

export function decodeDeepSeek(input: unknown) {
  const body = record(input)
  if (typeof body.is_available !== "boolean" || !Array.isArray(body.balance_infos))
    throw new ProviderUsage.AdapterError({ kind: "schema" })
  return body.balance_infos.map((entry, order) => {
    const value = record(entry)
    if (typeof value.currency !== "string") throw new ProviderUsage.AdapterError({ kind: "schema" })
    return new ProviderUsage.Meter({
      id: `balance:${value.currency}`,
      label: `${value.currency} balance`,
      kind: "balance",
      remaining: finite(value.total_balance),
      unit: value.currency,
      order,
    })
  })
}

export function decodeMoonshot(input: unknown) {
  const data = record(record(input).data)
  return [
    new ProviderUsage.Meter({
      id: "balance:cny",
      label: "Available balance",
      kind: "balance",
      remaining: finite(data.available_balance),
      unit: "CNY",
      order: 0,
    }),
  ]
}

export function decodeMiniMax(input: unknown) {
  const body = record(input)
  const remains = Array.isArray(body.remains) ? body.remains : Array.isArray(body.data) ? body.data : undefined
  if (!remains) throw new ProviderUsage.AdapterError({ kind: "schema" })
  return remains.map((entry, order) => {
    const value = record(entry)
    return new ProviderUsage.Meter({
      id: typeof value.type === "string" ? value.type : `window:${order}`,
      label: typeof value.name === "string" ? value.name : `Token plan ${order + 1}`,
      kind: "quota",
      remaining: finite(value.remains ?? value.remaining),
      ...(value.total !== undefined ? { limit: finite(value.total) } : {}),
      unit: "tokens",
      ...(value.reset_at !== undefined ? { resetsAt: finite(value.reset_at) } : {}),
      order,
    })
  })
}

export function decodeWham(input: unknown) {
  const limit = record(record(input).rate_limit)
  return ["primary_window", "secondary_window"].flatMap((id, order) => {
    if (limit[id] === undefined) return []
    const value = record(limit[id])
    const used = finite(value.used_percent)
    if (used < 0 || used > 100) throw new ProviderUsage.AdapterError({ kind: "schema" })
    return [
      new ProviderUsage.Meter({
        id,
        label: order ? "Weekly limit" : "5 hour limit",
        kind: "quota",
        used,
        remaining: 100 - used,
        limit: 100,
        unit: "percentage",
        resetsAt: finite(value.reset_at),
        order,
      }),
    ]
  })
}

export type OpenAIRateLimitStore = ReturnType<typeof openAIRateLimitStore>

export function openAIRateLimitStore(now: () => number = Date.now) {
  const snapshots = new Map<string, ProviderUsage.Snapshot>()
  const ingest = (auth: Auth.Info, headers: Headers) => {
    if (auth.type !== "api") return
    const limits = [
      ["requests", "x-ratelimit-limit-requests", "x-ratelimit-remaining-requests", "x-ratelimit-reset-requests"],
      ["tokens", "x-ratelimit-limit-tokens", "x-ratelimit-remaining-tokens", "x-ratelimit-reset-tokens"],
    ] as const
    const meters = limits.flatMap(([unit, limit, remaining, reset], order) => {
      if (!headers.has(limit) || !headers.has(remaining)) return []
      return [
        new ProviderUsage.Meter({
          id: `rate:${unit}`,
          label: `${unit} rate limit`,
          kind: "rate_limit",
          limit: finite(headers.get(limit)),
          remaining: finite(headers.get(remaining)),
          unit,
          ...(headers.has(reset) ? { resetsAt: now() + duration(headers.get(reset)) } : {}),
          order,
        }),
      ]
    })
    if (meters.length)
      snapshots.set(
        auth.key,
        new ProviderUsage.Snapshot({ providerID: "openai", fetchedAt: now(), source: "response_headers", meters }),
      )
  }
  const adapter: ProviderUsage.Adapter = {
    providerID: "openai",
    probe: ({ auth }) =>
      auth.type === "api" && snapshots.has(auth.key) ? { status: "ready" } : { status: "unsupported" },
    fetch: async ({ auth }) => {
      if (auth.type !== "api" || !snapshots.has(auth.key)) throw new ProviderUsage.AdapterError({ kind: "schema" })
      return snapshots.get(auth.key)!
    },
  }
  return { ingest, adapter }
}

function duration(input: string | null) {
  if (!input) throw new ProviderUsage.AdapterError({ kind: "schema" })
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(input)
  if (!match) throw new ProviderUsage.AdapterError({ kind: "schema" })
  return Number(match[1]) * { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"]
}
