import { describe, expect, test } from "bun:test"
import { activeRequest, load, meterDetails, orderedMeters, status, summary, truncateParts } from "../src/provider-usage"

const snapshot = {
  providerID: "openai",
  source: "official_api" as const,
  meters: [{ id: "quota", label: "Quota", remaining: 72, limit: 100, unit: "percentage", order: 0 }],
  fetchedAt: 1,
}

const result = (state: "available" | "stale" = "available") => ({
  providerID: "openai",
  status: state,
  snapshot,
})

describe("provider usage presentation", () => {
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
              { id: "requests", label: "Requests", remaining: 9, unit: "requests", order: 1 },
            ],
            fetchedAt: 1,
            providerID: "openai",
            source: "official_api",
          },
        },
        ["requests", "quota"],
      ),
    ).toBe("9 requests · 72% left")
    expect(summary(result(), [])).toBeUndefined()
  })

  test("presents loading and every provider-neutral result state distinctly", () => {
    expect(status(undefined)).toBe("◐ loading")
    expect(status({ providerID: "x", status: "unsupported" })).toBe("! unsupported")
    expect(status({ providerID: "x", status: "unauthenticated" })).toBe("! not signed in")
    expect(status({ providerID: "x", status: "error", error: "network" })).toBe("× unavailable")
    expect(status(result("stale"))).toBe("! 72% left (stale)")
    expect(status(result())).toBe("● 72% left")
  })

  test("keeps adapter order deterministic and honors saved meter order", () => {
    const meters = [
      { id: "later", label: "Later", remaining: 2, unit: "credits", order: 2 },
      { id: "beta", label: "Beta", remaining: 1, unit: "credits", order: 1 },
      { id: "alpha", label: "Alpha", remaining: 1, unit: "credits", order: 1 },
    ]
    expect(orderedMeters(meters).map((meter) => meter.id)).toEqual(["alpha", "beta", "later"])
    expect(orderedMeters(meters, ["later", "missing", "alpha"]).map((meter) => meter.id)).toEqual(["later", "alpha"])
  })

  test("shows reliable meter fields and reset time in provider details", () => {
    expect(
      meterDetails({
        id: "requests",
        label: "Requests",
        used: 2,
        remaining: 8,
        limit: 10,
        unit: "requests",
        resetsAt: 1_700_000_000_000,
        order: 0,
      }),
    ).toBe("used 2 requests · remaining 8 requests · limit 10 requests · resets 2023-11-14 22:13:20 UTC")
  })

  test("truncates selected meters from the tail with one omission marker", () => {
    expect(truncateParts(["first", "second", "third"], 18)).toBe("first · second · …")
    expect(truncateParts(["a very long first meter", "second"], 10)).toBe("a very lo…")
    expect(summary(result(), undefined, 8)).toBe("72% left")
    expect(summary(result("stale"), undefined, 5)).toBe("stale")
  })

  test("queries the selected provider and only revalidates its completed turn", () => {
    expect(activeRequest("deepseek", "openai")).toEqual({ providerID: "deepseek", refresh: false })
    expect(activeRequest("deepseek", "deepseek")).toEqual({ providerID: "deepseek", refresh: true })
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
