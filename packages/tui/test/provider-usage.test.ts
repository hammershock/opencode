import { describe, expect, test } from "bun:test"
import { load, summary } from "../src/provider-usage"

describe("provider usage presentation", () => {
  test("summarizes reliable and stale meters without provider branches", () => {
    const snapshot = {
      meters: [{ id: "quota", label: "Quota", remaining: 72, limit: 100, unit: "percentage", order: 0 }],
      fetchedAt: 1,
    }
    expect(summary({ status: "available", snapshot })).toBe("72% left")
    expect(summary({ status: "stale", snapshot })).toBe("72% left (stale)")
    expect(summary({ status: "error" })).toBeUndefined()
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
    expect(urls[0]).toContain("refresh=true")
    expect(urls[0]).toContain("directory=%2Fwork")
  })
})
