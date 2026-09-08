export * as SyncRoot from "./root"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"
import { SyncProvider } from "./provider"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const REMOTE_ROOT = "/apps/opencode-sync/session-sync"
export const INTERNAL_SCOPE = "account-v1"

export const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  protocol: Schema.Struct({ major: PositiveInt, minor: NonNegativeInt }),
  createdAt: NonNegativeInt,
})
export type Manifest = typeof Manifest.Type

export const Inspection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("uninitialized") }),
  Schema.Struct({ status: Schema.Literal("ready"), manifest: Manifest }),
  Schema.Struct({ status: Schema.Literal("incompatible"), version: NonNegativeInt }),
])
export type Inspection = typeof Inspection.Type

export class RootError extends Error {
  override readonly name = "SyncRoot.Error"

  constructor(readonly kind: "conflict" | "invalid" | "cleanup") {
    super(`Sync root failed: ${kind}`)
  }
}

export function make(input: { readonly provider: SyncProvider.Adapter; readonly now?: () => number }) {
  const now = input.now ?? Date.now

  const inspect = async (signal?: AbortSignal): Promise<Inspection> => {
    const object = await input.provider.stat("manifest.json", signal)
    if (!object) return { status: "uninitialized" }
    const downloaded = await input.provider.download(object.path, object.version, signal)
    const parsed = parse(downloaded.bytes)
    if (typeof parsed === "object" && parsed && "version" in parsed && parsed.version !== 1)
      return { status: "incompatible", version: typeof parsed.version === "number" ? parsed.version : 0 }
    try {
      const manifest = Schema.decodeUnknownSync(Manifest)(parsed)
      if (manifest.protocol.major !== 1 || manifest.protocol.minor > 0)
        return { status: "incompatible", version: manifest.protocol.major }
      return { status: "ready", manifest }
    } catch {
      throw new RootError("invalid")
    }
  }

  const initialize = async (signal?: AbortSignal) => {
    const current = await inspect(signal)
    if (current.status === "ready") return current.manifest
    if (current.status === "incompatible") throw new RootError("invalid")
    await clearObjects(input.provider, signal)
    const manifest: Manifest = { version: 1, protocol: { major: 1, minor: 0 }, createdAt: now() }
    try {
      await input.provider.uploadAtomic("manifest.json", encode(manifest), { type: "absent" }, signal)
      return manifest
    } catch (cause) {
      if (!(cause instanceof SyncProvider.ProviderError) || cause.kind !== "conflict") throw cause
      const winner = await inspect(signal)
      if (winner.status !== "ready") throw new RootError("conflict")
      return winner.manifest
    }
  }

  const clear = async (signal?: AbortSignal) => {
    // The manifest is the commit point. Removing it first makes every upload
    // racing this reset an invisible orphan until a later explicit initialize.
    const manifest = await input.provider.stat("manifest.json", signal)
    if (manifest) {
      const result = await input.provider.deleteBatch([{ path: manifest.path, version: manifest.version }], signal)
      if (result.some((item) => item.status === "conflict")) throw new RootError("conflict")
    }
    await clearObjects(input.provider, signal)
  }

  return { inspect, initialize, clear }
}

async function clearObjects(provider: SyncProvider.Adapter, signal?: AbortSignal) {
  const objects = (
    await Promise.all(
      ["devices", "segments", "deletions", "chunks"].map((prefix) => SyncProvider.listAll(provider, prefix, signal)),
    )
  ).flat()
  for (const batch of chunk(objects, 100)) {
    const result = await provider.deleteBatch(
      batch.map((item) => ({ path: item.path, version: item.version })),
      signal,
    )
    if (result.some((item) => item.status === "conflict")) throw new RootError("cleanup")
  }
}

function chunk<A>(values: readonly A[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, (index + 1) * size))
}

function encode(value: Manifest) {
  return encoder.encode(JSON.stringify(value))
}

function parse(value: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(value))
  } catch {
    throw new RootError("invalid")
  }
}
