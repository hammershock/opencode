export * as SyncCrypto from "./crypto"

import { Schema } from "effect"
import { gzipSync, gunzipSync } from "node:zlib"
import { NonNegativeInt, PositiveInt } from "../schema"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })
const protocol = 1 as const
const keyLength = 32
const nonceLength = 12
const tagLength = 16

export const Purpose = Schema.Literals(["metadata", "event", "attachment", "object-id"])
export type Purpose = typeof Purpose.Type

export const ObjectContext = Schema.Struct({
  path: Schema.NonEmptyString,
  type: Schema.NonEmptyString,
  deviceID: Schema.NonEmptyString,
  generation: NonNegativeInt,
  range: Schema.NonEmptyString,
  schemaVersion: PositiveInt,
})
export type ObjectContext = typeof ObjectContext.Type

export const Envelope = Schema.Struct({
  version: Schema.Literal(protocol),
  keyEpoch: PositiveInt,
  nonce: Schema.NonEmptyString,
  ciphertext: Schema.NonEmptyString,
  tag: Schema.NonEmptyString,
})
export type Envelope = typeof Envelope.Type

export interface SpaceKey {
  readonly namespaceID: string
  readonly rootKey: Uint8Array
}

export class InvalidRecoveryStringError extends Error {
  override readonly name = "SyncCrypto.InvalidRecoveryStringError"
}

export class CorruptEnvelopeError extends Error {
  override readonly name = "SyncCrypto.CorruptEnvelopeError"
}

export function createSpace(): SpaceKey {
  return { namespaceID: base64url(random(16)), rootKey: random(keyLength) }
}

export async function exportRecoveryString(space: SpaceKey): Promise<string> {
  assertRootKey(space.rootKey)
  const body = base64url(
    encoder.encode(canonical({ namespaceID: space.namespaceID, rootKey: base64url(space.rootKey) })),
  )
  const checksum = base64url(
    new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`ocr1.${body}`))),
  ).slice(0, 12)
  return `ocr1.${body}.${checksum}`
}

export async function importRecoveryString(value: string): Promise<SpaceKey> {
  try {
    const [version, body, checksum, extra] = value.split(".")
    if (version !== "ocr1" || !body || !checksum || extra) throw new InvalidRecoveryStringError()
    const expected = base64url(
      new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`ocr1.${body}`))),
    ).slice(0, 12)
    if (!constantTimeEqual(checksum, expected)) throw new InvalidRecoveryStringError()
    const parsed = JSON.parse(decoder.decode(fromBase64url(body))) as unknown
    const record = Schema.decodeUnknownSync(
      Schema.Struct({ namespaceID: Schema.NonEmptyString, rootKey: Schema.NonEmptyString }),
    )(parsed)
    const rootKey = fromBase64url(record.rootKey)
    assertRootKey(rootKey)
    return { namespaceID: record.namespaceID, rootKey }
  } catch (error) {
    if (error instanceof InvalidRecoveryStringError) throw error
    throw new InvalidRecoveryStringError()
  }
}

export async function encrypt(
  rootKey: Uint8Array,
  purpose: Exclude<Purpose, "object-id">,
  keyEpoch: number,
  context: ObjectContext,
  plaintext: Uint8Array,
): Promise<Envelope> {
  assertRootKey(rootKey)
  const nonce = random(nonceLength)
  const key = await derive(rootKey, purpose, keyEpoch, ["encrypt", "decrypt"])
  const aad = associatedData(purpose, keyEpoch, context)
  const compressed = gzipSync(plaintext)
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 }, key, compressed),
  )
  return {
    version: protocol,
    keyEpoch,
    nonce: base64url(nonce),
    ciphertext: base64url(sealed.subarray(0, -tagLength)),
    tag: base64url(sealed.subarray(-tagLength)),
  }
}

export async function decrypt(
  rootKey: Uint8Array,
  purpose: Exclude<Purpose, "object-id">,
  context: ObjectContext,
  input: unknown,
): Promise<Uint8Array> {
  try {
    assertRootKey(rootKey)
    const envelope = Schema.decodeUnknownSync(Envelope)(input)
    const nonce = fromBase64url(envelope.nonce)
    const ciphertext = fromBase64url(envelope.ciphertext)
    const tag = fromBase64url(envelope.tag)
    if (nonce.length !== nonceLength || tag.length !== tagLength) throw new CorruptEnvelopeError()
    const key = await derive(rootKey, purpose, envelope.keyEpoch, ["encrypt", "decrypt"])
    const sealed = new Uint8Array(ciphertext.length + tag.length)
    sealed.set(ciphertext)
    sealed.set(tag, ciphertext.length)
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: nonce,
        additionalData: associatedData(purpose, envelope.keyEpoch, context),
        tagLength: 128,
      },
      key,
      sealed,
    )
    return new Uint8Array(gunzipSync(new Uint8Array(opened)))
  } catch (error) {
    if (error instanceof CorruptEnvelopeError) throw error
    throw new CorruptEnvelopeError()
  }
}

export async function objectID(rootKey: Uint8Array, keyEpoch: number, plaintext: Uint8Array): Promise<string> {
  assertRootKey(rootKey)
  const key = await derive(rootKey, "object-id", keyEpoch, ["sign"])
  return base64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, Uint8Array.from(plaintext))))
}

async function derive(
  rootKey: Uint8Array,
  purpose: Purpose,
  keyEpoch: number,
  usages: Array<"encrypt" | "decrypt" | "sign">,
) {
  if (!Number.isSafeInteger(keyEpoch) || keyEpoch < 1) throw new Error("Invalid key epoch")
  const material = await crypto.subtle.importKey("raw", Uint8Array.from(rootKey), "HKDF", false, ["deriveKey"])
  const params = {
    name: "HKDF",
    hash: "SHA-256",
    salt: encoder.encode(`opencode-sync/v${protocol}/epoch/${keyEpoch}`),
    info: encoder.encode(`opencode-sync/${purpose}`),
  }
  if (purpose === "object-id")
    return crypto.subtle.deriveKey(params, material, { name: "HMAC", hash: "SHA-256", length: 256 }, false, usages)
  return crypto.subtle.deriveKey(params, material, { name: "AES-GCM", length: 256 }, false, usages)
}

function associatedData(purpose: Purpose, keyEpoch: number, context: ObjectContext) {
  return encoder.encode(canonical({ protocol, keyEpoch, purpose, ...context }))
}

function canonical(value: Record<string, unknown>) {
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${JSON.stringify(item)}`)
    .join(",")}}`
}

function assertRootKey(value: Uint8Array) {
  if (value.length !== keyLength) throw new Error("Root key must be 256 bits")
}

function random(length: number) {
  return crypto.getRandomValues(new Uint8Array(length))
}

function base64url(value: Uint8Array) {
  return Buffer.from(value).toString("base64url")
}

function fromBase64url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url")
  return new Uint8Array(Buffer.from(value, "base64url"))
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  return difference === 0
}
