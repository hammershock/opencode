export type Meter = {
  id: string
  label: string
  remaining?: number
  limit?: number
  unit: string
  resetsAt?: number
  order: number
}

export type Result = {
  status: "available" | "unsupported" | "unauthenticated" | "error" | "stale"
  snapshot?: { meters: Meter[]; fetchedAt: number }
}

export async function load(
  sdk: { url: string; directory?: string; fetch: typeof fetch },
  providerID: string,
  refresh = false,
) {
  const url = new URL(`/provider/${encodeURIComponent(providerID)}/usage`, sdk.url)
  if (sdk.directory) url.searchParams.set("directory", sdk.directory)
  if (refresh) url.searchParams.set("refresh", "true")
  const response = await sdk.fetch(url)
  if (!response.ok) return { status: "error" } satisfies Result
  return (await response.json()) as Result
}

export function summary(result: Result | undefined) {
  if (!result?.snapshot || (result.status !== "available" && result.status !== "stale")) return
  const meter = result.snapshot.meters.toSorted((a, b) => a.order - b.order)[0]
  if (!meter || meter.remaining === undefined) return
  const value =
    meter.limit === 100 && meter.unit === "percentage"
      ? `${Math.round(meter.remaining)}% left`
      : `${meter.remaining} ${meter.unit}`
  return result.status === "stale" ? `${value} (stale)` : value
}
