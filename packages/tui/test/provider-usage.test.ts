import { describe, expect, test } from "bun:test"
import {
  activeRequest,
  formatResetCountdown,
  load,
  meterSummary,
  meterDetails,
  modelDialogWidth,
  modelFavoriteDescription,
  modelFooterWidth,
  modelTitleWidth,
  orderedMeters,
  providerHeaderWidths,
  status,
  summary,
  truncateParts,
} from "../src/provider-usage"

const snapshot = {
  providerID: "openai",
  source: "official_api" as const,
  meters: [
    { id: "quota", label: "Quota", kind: "quota" as const, remaining: 72, limit: 100, unit: "percentage", order: 0 },
  ],
  fetchedAt: 1,
}

const result = (state: "available" | "stale" = "available") => ({
  providerID: "openai",
  status: state,
  snapshot,
})

describe("provider usage presentation", () => {
  test("formats reset countdowns without negative or invalid durations", () => {
    const now = 1_700_000_000_000
    expect(formatResetCountdown(now - 1, now)).toBe("now")
    expect(formatResetCountdown(now + 30_000, now)).toBe("in 1m")
    expect(formatResetCountdown(now + 90 * 60_000, now)).toBe("in 1h 30m")
    expect(formatResetCountdown(now + 52 * 60 * 60_000, now)).toBe("in 2d 4h")
    expect(formatResetCountdown(Number.NaN, now)).toBeUndefined()
  })

  test("summarizes reliable and stale meters without provider branches", () => {
    expect(summary(result())).toBe("72% left")
    expect(summary(result("stale"))).toBe("72% left (stale)")
    expect(summary({ providerID: "openai", status: "error" })).toBeUndefined()
    expect(
      summary(
        {
          status: "available",
          providerID: "openai",
          snapshot: {
            meters: [
              ...snapshot.meters,
              { id: "requests", label: "Requests", kind: "rate_limit", remaining: 9, unit: "requests", order: 1 },
            ],
            fetchedAt: 1,
            providerID: "openai",
            source: "official_api",
          },
        },
        { selected: ["requests", "quota"] },
      ),
    ).toBe("9 requests · 72% left")
    expect(summary(result(), { selected: [] })).toBeUndefined()
  })

  test("presents loading and every provider-neutral result state distinctly", () => {
    const now = 1_700_000_000_000
    const reset = {
      ...result(),
      snapshot: {
        ...snapshot,
        meters: [{ ...snapshot.meters[0]!, resetsAt: now + 52 * 60 * 60_000 }],
      },
    }
    expect(status(undefined)).toBe("◐ loading")
    expect(status({ providerID: "x", status: "unsupported" })).toBe("! unsupported")
    expect(status({ providerID: "x", status: "unauthenticated" })).toBe("! not signed in")
    expect(status({ providerID: "x", status: "error", error: "network" })).toBe("× unavailable")
    expect(status(result("stale"))).toBe("! Quota 72% (stale)")
    expect(status(result())).toBe("● Quota 72%")
    expect(status(reset, undefined, now)).toBe("● Quota 72% reset 2d4h")
  })

  test("keeps adapter order deterministic and honors saved meter order", () => {
    const meters = [
      { id: "later", label: "Later", kind: "credits" as const, remaining: 2, unit: "credits", order: 2 },
      { id: "beta", label: "Beta", kind: "credits" as const, remaining: 1, unit: "credits", order: 1 },
      { id: "alpha", label: "Alpha", kind: "credits" as const, remaining: 1, unit: "credits", order: 1 },
    ]
    expect(orderedMeters(meters).map((meter) => meter.id)).toEqual(["alpha", "beta", "later"])
    expect(orderedMeters(meters, ["later", "missing", "alpha"]).map((meter) => meter.id)).toEqual(["later", "alpha"])
  })

  test("shows reliable meter fields and reset time in provider details", () => {
    const now = 1_700_000_000_000
    const meter = {
      id: "requests",
      label: "Weekly limit",
      kind: "quota" as const,
      used: 2,
      remaining: 8,
      limit: 10,
      unit: "requests",
      resetsAt: now + 52 * 60 * 60_000,
      order: 0,
    }
    expect(meterDetails(meter, now)).toBe(
      "used 2 requests · remaining 8 requests · resets in 2d 4h · limit 10 requests",
    )
    expect(meterDetails({ ...meter, remaining: 72, limit: 100, unit: "percentage" }, now)).toBe(
      "used 2% · remaining 72% · resets in 2d 4h · limit 100%",
    )
    expect(meterSummary(meter, { now })).toBe("8 requests · resets in 2d 4h")
    expect(meterSummary(meter, { now, compact: true })).toBe("7d 8 requests reset 2d4h")
  })

  test("truncates selected meters from the tail with one omission marker", () => {
    expect(truncateParts(["first", "second", "third"], 18)).toBe("first · second · …")
    expect(truncateParts(["a very long first meter", "second"], 10)).toBe("a very lo…")
    expect(summary(result(), { maxWidth: 8 })).toBe("72% left")
    expect(summary(result("stale"), { maxWidth: 5 })).toBe("stale")
  })

  test("queries the selected provider and only revalidates its completed turn", () => {
    expect(activeRequest("deepseek", "openai")).toEqual({ providerID: "deepseek", refresh: false })
    expect(activeRequest("deepseek", "deepseek")).toEqual({ providerID: "deepseek", refresh: true })
  })

  test("budgets model rows and provider headers at supported viewport widths", () => {
    for (const terminalWidth of [40, 80, 120, 180]) {
      const dialogWidth = modelDialogWidth(terminalWidth)
      expect(dialogWidth).toBeLessThanOrEqual(116)
      expect(dialogWidth).toBeLessThanOrEqual(terminalWidth - 2)
      const free = Bun.stringWidth("Free")
      expect(modelTitleWidth(terminalWidth, { footerWidth: free }) + free + 13).toBeLessThanOrEqual(dialogWidth)

      const category = modelFooterWidth(terminalWidth)
      const favorite = modelFavoriteDescription(terminalWidth)
      expect(
        modelTitleWidth(terminalWidth, { footerWidth: category, description: favorite }) +
          category +
          (favorite ? Bun.stringWidth(favorite) + 1 : 0) +
          13,
      ).toBeLessThanOrEqual(dialogWidth)

      const header = providerHeaderWidths(terminalWidth, "A provider with a long but bounded display name")
      expect(header.title + header.usage + 11).toBeLessThanOrEqual(dialogWidth)
      expect(Bun.stringWidth(status(result(), header.usage))).toBeLessThanOrEqual(header.usage)
    }
  })

  test("supports refresh and treats endpoint failure as display-only", async () => {
    const urls: string[] = []
    const result = await load(
      {
        url: "http://localhost:4096",
        directory: "/work",
        fetch: async (input) => {
          urls.push(String(input))
          return new Response("unavailable", { status: 503 })
        },
      },
      "openai",
      true,
    )
    expect(result.status).toBe("error")
    expect(result.providerID).toBe("openai")
    expect(urls[0]).toContain("refresh=true")
    expect(urls[0]).toContain("directory=%2Fwork")

    const rejected = await load(
      {
        url: "http://localhost:4096",
        fetch: () => Promise.reject(new TypeError("connection failed")),
      },
      "openai",
    )
    expect(rejected).toEqual({ providerID: "openai", status: "error", error: "network" })
  })
})
