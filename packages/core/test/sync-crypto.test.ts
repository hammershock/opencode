import { describe, expect, test } from "bun:test"
import { SyncCrypto } from "@opencode-ai/core/sync/crypto"

const context = {
  path: "objects/device-a/1",
  type: "segment",
  deviceID: "device-a",
  generation: 1,
  range: "0-3",
  schemaVersion: 1,
} as const

describe("SyncCrypto", () => {
  test("round trips versioned recovery strings and rejects tampering", async () => {
    const space = SyncCrypto.createSpace()
    const recovery = await SyncCrypto.exportRecoveryString(space)
    const restored = await SyncCrypto.importRecoveryString(recovery)
    expect(restored.namespaceID).toBe(space.namespaceID)
    expect(restored.rootKey).toEqual(space.rootKey)
    expect(recovery).not.toContain(Buffer.from(space.rootKey).toString("hex"))

    await expect(SyncCrypto.importRecoveryString(`${recovery.slice(0, -1)}x`)).rejects.toBeInstanceOf(
      SyncCrypto.InvalidRecoveryStringError,
    )
  })

  test("encrypts compressed payloads and authenticates every object context field", async () => {
    const root = SyncCrypto.createSpace().rootKey
    const value = new TextEncoder().encode("private session payload ".repeat(64))
    const envelope = await SyncCrypto.encrypt(root, "event", 1, context, value)
    expect(envelope.ciphertext).not.toContain("private")
    expect(await SyncCrypto.decrypt(root, "event", context, envelope)).toEqual(value)

    for (const changed of [
      { ...context, path: `${context.path}-other` },
      { ...context, type: "metadata" },
      { ...context, deviceID: "device-b" },
      { ...context, generation: 2 },
      { ...context, range: "1-3" },
      { ...context, schemaVersion: 2 },
    ]) {
      await expect(SyncCrypto.decrypt(root, "event", changed, envelope)).rejects.toBeInstanceOf(
        SyncCrypto.CorruptEnvelopeError,
      )
    }
  })

  test("rejects wrong keys, purposes, versions, nonces, ciphertext and tags", async () => {
    const root = SyncCrypto.createSpace().rootKey
    const envelope = await SyncCrypto.encrypt(root, "metadata", 2, context, new TextEncoder().encode("secret"))
    const cases: Array<unknown> = [
      { ...envelope, version: 2 },
      { ...envelope, nonce: "AA" },
      { ...envelope, ciphertext: flip(envelope.ciphertext) },
      { ...envelope, tag: flip(envelope.tag) },
    ]
    for (const item of cases)
      await expect(SyncCrypto.decrypt(root, "metadata", context, item)).rejects.toBeInstanceOf(
        SyncCrypto.CorruptEnvelopeError,
      )
    await expect(
      SyncCrypto.decrypt(SyncCrypto.createSpace().rootKey, "metadata", context, envelope),
    ).rejects.toBeInstanceOf(SyncCrypto.CorruptEnvelopeError)
    await expect(SyncCrypto.decrypt(root, "event", context, envelope)).rejects.toBeInstanceOf(
      SyncCrypto.CorruptEnvelopeError,
    )
  })

  test("uses keyed stable object identifiers without exposing plaintext hashes", async () => {
    const payload = new TextEncoder().encode("same chunk")
    const first = SyncCrypto.createSpace().rootKey
    const second = SyncCrypto.createSpace().rootKey
    expect(await SyncCrypto.objectID(first, 1, payload)).toBe(await SyncCrypto.objectID(first, 1, payload))
    expect(await SyncCrypto.objectID(first, 1, payload)).not.toBe(await SyncCrypto.objectID(second, 1, payload))
    expect(await SyncCrypto.objectID(first, 1, payload)).not.toBe(await SyncCrypto.objectID(first, 2, payload))
  })
})

function flip(value: string) {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`
}
