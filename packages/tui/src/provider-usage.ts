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
  sdk: { url: string; directory?: string; fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> },
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

export function summary(result: Result | undefined, selected?: string[]) {
  if (!result?.snapshot || (result.status !== "available" && result.status !== "stale")) return
  const values = result.snapshot.meters
    .toSorted((a, b) => {
      if (!selected) return a.order - b.order
      return selected.indexOf(a.id) - selected.indexOf(b.id)
    })
    .filter((meter) => selected === undefined || selected.includes(meter.id))
    .flatMap((meter) => {
      if (meter.remaining === undefined) return []
      return [
        meter.limit === 100 && meter.unit === "percentage"
          ? `${Math.round(meter.remaining)}% left`
          : `${meter.remaining} ${meter.unit}`,
      ]
    })
  if (!values.length) return
  const value = values.join(" · ")
  return result.status === "stale" ? `${value} (stale)` : value
}
