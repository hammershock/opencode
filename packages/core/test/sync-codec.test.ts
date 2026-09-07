import { describe, expect, test } from "bun:test"
import { SyncCodec } from "@opencode-ai/core/sync/codec"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"

const context = {
  path: "segments/device/1-1.json",
  type: "segment",
  deviceID: "device",
  generation: 1,
  range: "1-1",
  schemaVersion: 1,
}

describe("SyncCodec", () => {
  test("plaintext mode binds integrity to the object context without a key", async () => {
    const codec = SyncCodec.plaintext()
    const source = new TextEncoder().encode('{"title":"visible"}')
    const sealed = await codec.seal("event", context, source)
    expect(new TextDecoder().decode(await codec.open("event", context, sealed))).toBe('{"title":"visible"}')
    expect(codec.suffix).toBe(".json")

    const changed = new Uint8Array(sealed)
    changed[changed.length - 3] ^= 1
    await expect(codec.open("event", context, changed)).rejects.toBeInstanceOf(SyncCodec.CorruptPlainEnvelopeError)
    await expect(codec.open("event", { ...context, path: "segments/device/2-2.json" }, sealed)).rejects.toBeInstanceOf(
      SyncCodec.CorruptPlainEnvelopeError,
    )
  })

  test("encrypted mode keeps the existing encrypted envelope contract", async () => {
    const codec = SyncCodec.encrypted(SyncCrypto.createSpace().rootKey)
    const source = new TextEncoder().encode("private")
    const sealed = await codec.seal("event", { ...context, path: "segments/device/1-1.enc" }, source)
    expect(new TextDecoder().decode(sealed)).not.toContain("private")
    expect(await codec.open("event", { ...context, path: "segments/device/1-1.enc" }, sealed)).toEqual(source)
  })
})
