import { describe, expect, test } from "bun:test"
import { verifyBuildManifestFromStream } from "@/cli/cmd/deploy-verify-build-manifest"

const commit = "a".repeat(40)
const version = `1.18.29-transit.0+${commit.slice(0, 12)}`

describe("release build manifest verification", () => {
  test("accepts a clean manifest paired with the running build", async () => {
    await expect(verifyBuildManifestFromStream(stream(manifest()), version)).resolves.toBeUndefined()
  })

  test("accepts matching dirty build identity", async () => {
    await expect(
      verifyBuildManifestFromStream(stream(manifest({ version: `${version}.dirty`, dirty: true })), `${version}.dirty`),
    ).resolves.toBeUndefined()
  })

  test.each([
    ["product", { product: "OpenCode" }],
    ["entrypoint", { entrypoint: "opencode" }],
    ["version", { version: `1.18.29-transit.0+${"b".repeat(12)}` }],
    ["upstream version", { upstreamVersion: "1.18.28" }],
    ["commit", { commit: "b".repeat(40) }],
    ["commit shape", { commit: "a".repeat(12) }],
    ["dirty state", { dirty: true }],
    ["target", { target: "" }],
    ["built at", { builtAt: "not-a-date" }],
  ])("rejects mismatched %s", async (_name, patch) => {
    await expect(verifyBuildManifestFromStream(stream(manifest(patch)), version)).rejects.toThrow(
      "Invalid build manifest",
    )
  })

  test("rejects invalid or oversized input without echoing it", async () => {
    await expect(verifyBuildManifestFromStream(stream("not-json"), version)).rejects.toThrow("Invalid build manifest")
    await expect(verifyBuildManifestFromStream(stream("x".repeat(16 * 1024 + 1)), version)).rejects.toThrow(
      "Invalid build manifest",
    )
  })
})

function manifest(patch: Record<string, unknown> = {}) {
  return JSON.stringify({
    product: "OpenCode Transit",
    entrypoint: "opencode-transit",
    version,
    upstreamVersion: "1.18.29",
    commit,
    dirty: false,
    target: "opencode-darwin-arm64",
    builtAt: "2026-09-11T00:00:00.000Z",
    ...patch,
  })
}

async function* stream(value: string) {
  yield value
}
