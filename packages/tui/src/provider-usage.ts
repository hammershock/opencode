export type Meter = {
  id: string
  label: string
  kind: "balance" | "quota" | "rate_limit" | "credits" | "custom"
  used?: number
  remaining?: number
  limit?: number
  unit: string
  resetsAt?: number
  order: number
}

export type Result = {
  providerID: string
  status: "available" | "unsupported" | "unauthenticated" | "error" | "stale"
  snapshot?: {
    providerID: string
    accountID?: string
    scopeID?: string
    fetchedAt: number
    expiresAt?: number
    source: "official_api" | "response_headers" | "experimental_private"
    meters: Meter[]
  }
  error?: "authentication" | "rate_limit" | "timeout" | "schema" | "network" | "unknown"
}

export async function load(
  sdk: { url: string; directory?: string; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
  providerID: string,
  refresh = false,
  signal?: AbortSignal,
) {
  const url = new URL(`/provider/${encodeURIComponent(providerID)}/usage`, sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)
  if (refresh) url.searchParams.set("refresh", "true")
  const response = await sdk.fetch(url, { signal }).catch((cause) => {
    if (signal?.aborted) throw cause
    return undefined
  })
  if (!response) return { providerID, status: "error", error: "network" } satisfies Result
  if (!response.ok) return { providerID, status: "error" } satisfies Result
  return (await response.json()) as Result
}

export function activeRequest(providerID: string, completedProviderID?: string) {
  return { providerID, refresh: completedProviderID === providerID }
}

export function orderedMeters(meters: Meter[], selected?: string[]) {
  return meters
    .toSorted((a, b) => {
      if (!selected) return a.order - b.order || a.id.localeCompare(b.id)
      const left = selected.indexOf(a.id)
      const right = selected.indexOf(b.id)
      if (left === -1 && right === -1) return a.order - b.order || a.id.localeCompare(b.id)
      if (left === -1) return 1
      if (right === -1) return -1
      return left - right
    })
    .filter((meter) => selected === undefined || selected.includes(meter.id))
}

export function meterSummary(meter: Meter, options?: { now?: number; compact?: boolean }): string | undefined {
  const compact = options?.compact ?? false
  const remaining =
    meter.remaining === undefined
      ? undefined
      : meter.limit === 100 && meter.unit === "percentage"
        ? `${Math.round(meter.remaining)}%${compact ? "" : " left"}`
        : `${meter.remaining} ${meter.unit}`
  const reset =
    meter.resetsAt === undefined ? undefined : formatResetCountdown(meter.resetsAt, options?.now ?? Date.now())
  if (compact) {
    const label = meter.kind === "quota" || meter.kind === "rate_limit" ? compactMeterLabel(meter.label) : undefined
    return (
      [label, remaining, reset === undefined ? undefined : `reset ${reset.replace(/^in /, "").replaceAll(" ", "")}`]
        .filter((value): value is string => value !== undefined)
        .join(" ") || undefined
    )
  }
  return (
    [remaining, reset === undefined ? undefined : `resets ${reset}`]
      .filter((value): value is string => value !== undefined)
      .join(" · ") || undefined
  )
}

export function summary(
  result: Result | undefined,
  options?: { selected?: string[]; maxWidth?: number; now?: number; compact?: boolean },
): string | undefined {
  if (!result?.snapshot || (result.status !== "available" && result.status !== "stale")) return
  const values = orderedMeters(result.snapshot.meters, options?.selected).flatMap((meter) => {
    const value = meterSummary(meter, { now: options?.now, compact: options?.compact })
    return value ? [value] : []
  })
  if (!values.length) return
  const suffix = result.status === "stale" ? " (stale)" : ""
  if (options?.maxWidth !== undefined && options.maxWidth <= suffix.length) return "stale".slice(0, options.maxWidth)
  return truncateParts(values, options?.maxWidth === undefined ? undefined : options.maxWidth - suffix.length) + suffix
}

export function status(result: Result | undefined, maxWidth?: number, now = Date.now()) {
  const value = (() => {
    if (!result) return "◐ loading"
    if (result.status === "unsupported") return "! unsupported"
    if (result.status === "unauthenticated") return "! not signed in"
    if (result.status === "error") return "× unavailable"
    const marker = result.status === "stale" ? "! " : "● "
    const first = summary(result, {
      selected: result.snapshot
        ? orderedMeters(result.snapshot.meters)
            .slice(0, 1)
            .map((x) => x.id)
        : [],
      maxWidth: maxWidth === undefined ? undefined : Math.max(0, maxWidth - marker.length),
      now,
      compact: true,
    })
    if (result.status === "stale") return `${marker}${first ?? "usage"}`
    return `${marker}${first ?? "available"}`
  })()
  return maxWidth === undefined ? value : fitText(value, maxWidth)
}

export function modelDialogWidth(terminalWidth: number) {
  return Math.min(116, Math.max(1, terminalWidth - 2))
}

export function modelFooterWidth(terminalWidth: number) {
  return Math.max(8, Math.min(28, Math.floor(modelDialogWidth(terminalWidth) * 0.3)))
}

export function modelFavoriteDescription(terminalWidth: number) {
  return modelDialogWidth(terminalWidth) >= 60 ? "(Favorite)" : undefined
}

export function modelTitleWidth(
  terminalWidth: number,
  trailing?: { readonly footerWidth?: number; readonly description?: string },
) {
  const footer = trailing?.footerWidth ? trailing.footerWidth + 1 : 0
  const description = trailing?.description ? Bun.stringWidth(trailing.description) + 1 : 0
  return Math.max(8, modelDialogWidth(terminalWidth) - 12 - footer - description)
}

export function providerHeaderWidths(terminalWidth: number, providerName: string) {
  const available = Math.max(8, modelDialogWidth(terminalWidth) - 10)
  const title = Math.min(Bun.stringWidth(providerName), Math.max(4, Math.floor(available * 0.55)))
  return { title, usage: Math.max(4, available - title - 1) }
}

export function fitText(value: string, width: number) {
  if (width <= 0) return ""
  if (Bun.stringWidth(value) <= width) return value
  if (width === 1) return "…"
  return (
    [...value].reduce((result, character) => {
      if (Bun.stringWidth(result + character) >= width) return result
      return result + character
    }, "") + "…"
  )
}

export function meterDetails(meter: Meter, now = Date.now()) {
  const value = (input: number) =>
    meter.limit === 100 && meter.unit === "percentage" ? `${input}%` : `${input} ${meter.unit}`
  const reset = meter.resetsAt === undefined ? undefined : formatResetCountdown(meter.resetsAt, now)
  const values = [
    meter.used === undefined ? undefined : `used ${value(meter.used)}`,
    meter.remaining === undefined ? undefined : `remaining ${value(meter.remaining)}`,
    reset === undefined ? undefined : `resets ${reset}`,
    meter.limit === undefined ? undefined : `limit ${value(meter.limit)}`,
  ].filter((value): value is string => value !== undefined)
  return values.join(" · ") || meter.unit
}

export function formatResetCountdown(value: number, now = Date.now()) {
  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(now)) return
  if (value <= now) return "now"

  const minutes = Math.max(1, Math.ceil((value - now) / 60_000))
  const days = Math.floor(minutes / (24 * 60))
  const hours = Math.floor((minutes % (24 * 60)) / 60)
  if (days > 0) return `in ${days}d${hours > 0 ? ` ${hours}h` : ""}`

  const remainingMinutes = minutes % 60
  if (hours > 0) return `in ${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ""}`
  return `in ${minutes}m`
}

function compactMeterLabel(label: string) {
  if (label === "5 hour limit") return "5h"
  if (label === "Daily limit") return "24h"
  if (label === "Weekly limit") return "7d"
  if (label === "Monthly limit") return "30d"
  if (label === "Yearly limit") return "365d"
  return label.replace(/ limit$/i, "")
}

export function formatTime(value: number) {
  return new Date(value)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC")
}

export function truncateParts(parts: string[], maxWidth?: number) {
  const value = parts.join(" · ")
  if (maxWidth === undefined || value.length <= maxWidth) return value
  if (maxWidth <= 1) return "…".slice(0, maxWidth)

  let kept = ""
  for (const part of parts) {
    const candidate = kept ? `${kept} · ${part}` : part
    if (`${candidate} · …`.length > maxWidth) break
    kept = candidate
  }
  if (kept) return `${kept} · …`
  return `${parts[0]?.slice(0, maxWidth - 1) ?? ""}…`
}
