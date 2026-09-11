import { describe, expect, test } from "bun:test"
import { resolvePluginVersion } from "@opencode-ai/core/installation/version"

describe("installation plugin version", () => {
  test("uses the published compatibility baseline for a Transit build", () => {
    expect(resolvePluginVersion("1.18.29-transit.0+0123456789ab", "1.18.29")).toBe("1.18.29")
  })

  test("keeps the product version when no compatibility baseline is supplied", () => {
    expect(resolvePluginVersion("1.18.29")).toBe("1.18.29")
  })
})
