export type Meter = {
  id: string
  label: string
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

export function meterSummary(meter: Meter): string | undefined {
  if (meter.remaining === undefined) return
  return meter.limit === 100 && meter.unit === "percentage"
    ? `${Math.round(meter.remaining)}% left`
    : `${meter.remaining} ${meter.unit}`
}

export function summary(result: Result | undefined, selected?: string[], maxWidth?: number): string | undefined {
  if (!result?.snapshot || (result.status !== "available" && result.status !== "stale")) return
  const values = orderedMeters(result.snapshot.meters, selected).flatMap((meter) => {
    const value = meterSummary(meter)
    return value ? [value] : []
  })
  if (!values.length) return
  const suffix = result.status === "stale" ? " (stale)" : ""
  if (maxWidth !== undefined && maxWidth <= suffix.length) return "stale".slice(0, maxWidth)
  return truncateParts(values, maxWidth === undefined ? undefined : maxWidth - suffix.length) + suffix
}

export function status(result: Result | undefined, maxWidth?: number) {
  const value = (() => {
    if (!result) return "◐ loading"
    if (result.status === "unsupported") return "! unsupported"
    if (result.status === "unauthenticated") return "! not signed in"
    if (result.status === "error") return "× unavailable"
    const marker = result.status === "stale" ? "! " : "● "
    const first = summary(
      result,
      result.snapshot
        ? orderedMeters(result.snapshot.meters)
            .slice(0, 1)
            .map((x) => x.id)
        : [],
      maxWidth === undefined ? undefined : Math.max(0, maxWidth - marker.length),
    )
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

export function meterDetails(meter: Meter) {
  const values = [
    meter.used === undefined ? undefined : `used ${meter.used} ${meter.unit}`,
    meter.remaining === undefined ? undefined : `remaining ${meter.remaining} ${meter.unit}`,
    meter.limit === undefined ? undefined : `limit ${meter.limit} ${meter.unit}`,
  ].filter((value): value is string => value !== undefined)
  if (meter.resetsAt !== undefined) values.push(`resets ${formatTime(meter.resetsAt)}`)
  return values.join(" · ") || meter.unit
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
