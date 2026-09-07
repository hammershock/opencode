export * as SyncCodec from "./codec"

import { Schema } from "effect"
import { SyncCrypto } from "./crypto"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export type Purpose = "metadata" | "event" | "attachment"
export type Mode = "none" | "aes-256-gcm"

export interface Interface {
  readonly mode: Mode
  readonly suffix: ".json" | ".enc"
  readonly seal: (purpose: Purpose, context: SyncCrypto.ObjectContext, bytes: Uint8Array) => Promise<Uint8Array>
  readonly open: (purpose: Purpose, context: SyncCrypto.ObjectContext, bytes: Uint8Array) => Promise<Uint8Array>
  readonly objectID: (bytes: Uint8Array) => Promise<string>
}

const PlainEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  encoding: Schema.Literal("none"),
  context: Schema.String,
  digest: Schema.String,
  payload: Schema.String,
})

export class CorruptPlainEnvelopeError extends Error {
  override readonly name = "SyncCodec.CorruptPlainEnvelopeError"
}

export function plaintext(): Interface {
  const seal = async (_purpose: Purpose, context: SyncCrypto.ObjectContext, bytes: Uint8Array) => {
    const bound = canonical(context)
    return encoder.encode(
      JSON.stringify({
        version: 1,
        encoding: "none",
        context: bound,
        digest: await digest(concat(encoder.encode(bound), bytes)),
        payload: Buffer.from(bytes).toString("base64url"),
      }),
    )
  }
  const open = async (_purpose: Purpose, context: SyncCrypto.ObjectContext, bytes: Uint8Array) => {
    try {
      const envelope = Schema.decodeUnknownSync(PlainEnvelope)(JSON.parse(decoder.decode(bytes)))
      const bound = canonical(context)
      if (envelope.context !== bound) throw new CorruptPlainEnvelopeError()
      const payload = new Uint8Array(Buffer.from(envelope.payload, "base64url"))
      if ((await digest(concat(encoder.encode(bound), payload))) !== envelope.digest)
        throw new CorruptPlainEnvelopeError()
      return payload
    } catch (cause) {
      if (cause instanceof CorruptPlainEnvelopeError) throw cause
      throw new CorruptPlainEnvelopeError()
    }
  }
  return { mode: "none", suffix: ".json", seal, open, objectID: digest }
}

export function encrypted(rootKey: Uint8Array): Interface {
  return {
    mode: "aes-256-gcm",
    suffix: ".enc",
    seal: async (purpose, context, bytes) =>
      encoder.encode(JSON.stringify(await SyncCrypto.encrypt(rootKey, purpose, 1, context, bytes))),
    open: async (purpose, context, bytes) =>
      SyncCrypto.decrypt(rootKey, purpose, context, JSON.parse(decoder.decode(bytes))),
    objectID: (bytes) => SyncCrypto.objectID(rootKey, 1, bytes),
  }
}

async function digest(bytes: Uint8Array) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", bytes)).toString("base64url")
}

function concat(left: Uint8Array, right: Uint8Array) {
  const value = new Uint8Array(left.length + right.length)
  value.set(left)
  value.set(right, left.length)
  return value
}

function canonical(value: Record<string, unknown>) {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))))
}
