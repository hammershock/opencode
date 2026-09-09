export * as SyncRoot from "./root"

import { Schema } from "effect"
import { NonNegativeInt, PositiveInt } from "../schema"
import { SyncProvider } from "./provider"

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

export const REMOTE_ROOT = "/apps/opencode-sync/session-sync"
export const LEGACY_SCOPE = "account-v1"
/** @deprecated Use accountScope(instanceID) for every v2 runtime scope. */
export const INTERNAL_SCOPE = LEGACY_SCOPE
export const CONTROL_PATH = "control/current-v2.json"
export const LEGACY_MANIFEST_PATH = "manifest.json"

const InstanceID = Schema.NonEmptyString

export const Manifest = Schema.Struct({
  version: Schema.Literal(2),
  state: Schema.Literal("ready"),
  protocol: Schema.Struct({ major: PositiveInt, minor: NonNegativeInt }),
  instanceID: InstanceID,
  createdAt: NonNegativeInt,
})
export type Manifest = typeof Manifest.Type

export const Reset = Schema.Struct({
  version: Schema.Literal(2),
  state: Schema.Literal("reset"),
  resetID: InstanceID,
  resetAt: NonNegativeInt,
})
export type Reset = typeof Reset.Type

export const LegacyManifest = Schema.Struct({
  version: Schema.Literal(1),
  protocol: Schema.Struct({ major: PositiveInt, minor: NonNegativeInt }),
  createdAt: NonNegativeInt,
})
export type LegacyManifest = typeof LegacyManifest.Type

export const Inspection = Schema.Union([
  Schema.Struct({ status: Schema.Literal("uninitialized"), reset: Schema.optional(Reset) }),
  Schema.Struct({ status: Schema.Literal("legacy-upgrade-required"), manifest: LegacyManifest }),
  Schema.Struct({ status: Schema.Literal("ready"), manifest: Manifest }),
  Schema.Struct({ status: Schema.Literal("unavailable"), expectedInstanceID: InstanceID }),
  Schema.Struct({
    status: Schema.Literal("replaced"),
    manifest: Manifest,
    expectedInstanceID: InstanceID,
  }),
  Schema.Struct({ status: Schema.Literal("incompatible"), version: NonNegativeInt }),
])
export type Inspection = typeof Inspection.Type

export type ClearResult = {
  readonly invalidated: true
  readonly cleanup: "complete" | "pending"
  readonly reset: Reset
}

export class RootError extends Error {
  override readonly name = "SyncRoot.Error"

  constructor(readonly kind: "conflict" | "invalid" | "cleanup") {
    super(`Sync root failed: ${kind}`)
  }
}

export function accountScope(instanceID: string) {
  return `account-v2:${validatedInstanceID(instanceID)}`
}

export function accountInstanceID(scopeID: string) {
  const match = /^account-v2:([A-Za-z0-9_-]{1,128})$/.exec(scopeID)
  return match?.[1]
}

export function isAccountScope(scopeID: string) {
  return accountInstanceID(scopeID) !== undefined
}

export function instanceRoot(instanceID: string) {
  return `${REMOTE_ROOT}/instances/${validatedInstanceID(instanceID)}`
}

export function make(input: {
  readonly provider: SyncProvider.Adapter
  readonly now?: () => number
  readonly randomUUID?: () => string
  readonly sleep?: (milliseconds: number) => Promise<void>
}) {
  const now = input.now ?? Date.now
  // Web Crypto methods require their Crypto receiver in Bun's standalone
  // executables; keeping the bare method loses that receiver at call time.
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID())
  const sleep = input.sleep ?? Bun.sleep

  const inspect = async (signal?: AbortSignal): Promise<Inspection> => {
    const control = await input.provider.stat(CONTROL_PATH, signal)
    if (control) return parseControl((await input.provider.download(control.path, control.version, signal)).bytes)

    const legacy = await input.provider.stat(LEGACY_MANIFEST_PATH, signal)
    if (!legacy) return { status: "uninitialized" }
    const parsed = parse((await input.provider.download(legacy.path, legacy.version, signal)).bytes)
    if (typeof parsed === "object" && parsed && "version" in parsed && parsed.version !== 1)
      return { status: "incompatible", version: typeof parsed.version === "number" ? parsed.version : 0 }
    try {
      const manifest = Schema.decodeUnknownSync(LegacyManifest)(parsed)
      if (manifest.protocol.major !== 1 || manifest.protocol.minor > 0)
        return { status: "incompatible", version: manifest.protocol.major }
      return { status: "legacy-upgrade-required", manifest }
    } catch {
      throw new RootError("invalid")
    }
  }

  const initialize = async (signal?: AbortSignal) => {
    let current = await inspect(signal)
    // Creating a new epoch is destructive if an existing current pointer was
    // merely hidden by Baidu's metadata edge. Require several consecutive
    // exact-path absences; any positive observation wins immediately.
    if (current.status === "uninitialized" && !current.reset) {
      for (let attempt = 0; attempt < 4; attempt++) {
        signal?.throwIfAborted()
        await sleep(50 * 2 ** attempt)
        current = await inspect(signal)
        if (current.status !== "uninitialized" || current.reset) break
      }
    }
    if (current.status === "ready") return current.manifest
    if (current.status === "replaced") return current.manifest
    if (current.status === "legacy-upgrade-required" || current.status === "incompatible")
      throw new RootError("invalid")

    const manifest: Manifest = {
      version: 2,
      state: "ready",
      protocol: { major: 1, minor: 0 },
      instanceID: validatedInstanceID(randomUUID()),
      createdAt: now(),
    }
    const descriptorPath = `instances/${manifest.instanceID}/instance.json`
    await publishVerified(input.provider, descriptorPath, encode(manifest), { type: "absent" }, signal)
    await publishVerified(input.provider, CONTROL_PATH, encode(manifest), { type: "any" }, signal)
    const winner = await inspect(signal)
    if (winner.status === "ready" && winner.manifest.instanceID === manifest.instanceID) return winner.manifest
    throw new RootError("conflict")
  }

  const clear = async (signal?: AbortSignal): Promise<ClearResult> => {
    const current = await inspect(signal)
    const reset = Reset.make({
      version: 2,
      state: "reset",
      resetID: validatedInstanceID(randomUUID()),
      resetAt: now(),
    })
    await publishVerified(input.provider, CONTROL_PATH, encode(reset), { type: "any" }, signal)
    const invalidated = await inspect(signal)
    if (invalidated.status !== "uninitialized" || invalidated.reset?.resetID !== reset.resetID)
      throw new RootError("conflict")

    const prefixes = [
      // Reset is account-wide. Clean every discoverable epoch, not only the
      // instance that happened to be current when reset began. A writer that
      // was already in flight can still leave an unreachable orphan; it never
      // becomes visible through the reset control pointer and later cleanup
      // retries may remove it.
      "instances",
      ...(current.status === "legacy-upgrade-required" ? ["devices", "segments", "deletions", "chunks"] : []),
    ]
    const legacyCleanup = await input.provider
      .stat(LEGACY_MANIFEST_PATH, signal)
      .then(async (legacy) => {
        if (!legacy) return true
        const result = await input.provider.deleteBatch([legacy], signal)
        return !result.some((item) => item.status === "conflict")
      })
      .catch(() => false)
    const cleanup = await clearPrefixes(input.provider, prefixes, signal).catch(() => false)
    return {
      invalidated: true,
      cleanup: cleanup && legacyCleanup ? "complete" : "pending",
      reset,
    }
  }

  return { inspect, initialize, clear }
}

function parseControl(value: Uint8Array): Inspection {
  const parsed = parse(value)
  if (!parsed || typeof parsed !== "object" || !("version" in parsed)) throw new RootError("invalid")
  if (parsed.version !== 2)
    return { status: "incompatible", version: typeof parsed.version === "number" ? parsed.version : 0 }
  try {
    if ("state" in parsed && parsed.state === "reset")
      return { status: "uninitialized", reset: validReset(Schema.decodeUnknownSync(Reset)(parsed)) }
    const manifest = Schema.decodeUnknownSync(Manifest)(parsed)
    validatedInstanceID(manifest.instanceID)
    if (manifest.protocol.major !== 1 || manifest.protocol.minor > 0)
      return { status: "incompatible", version: manifest.protocol.major }
    return { status: "ready", manifest }
  } catch {
    throw new RootError("invalid")
  }
}

async function publishVerified(
  provider: SyncProvider.Adapter,
  path: string,
  bytes: Uint8Array,
  precondition: SyncProvider.Precondition,
  signal?: AbortSignal,
) {
  await provider.uploadAtomic(path, bytes, precondition, signal).catch(() => undefined)
  // Baidu may expose the previous rtype=3 generation through path metadata or
  // dlink for a short window after create succeeds. A single immediate read is
  // therefore neither a success proof nor a conflict proof. Only the exact
  // canonical bytes are accepted, after a bounded visibility window.
  for (let attempt = 0; attempt < 7; attempt++) {
    signal?.throwIfAborted()
    try {
      const current = await provider.stat(path, signal)
      if (current) {
        const downloaded = await provider.download(path, current.version, signal)
        if (equal(downloaded.bytes, bytes)) return current
      }
    } catch (cause) {
      if (!(cause instanceof SyncProvider.ProviderError) || !cause.retryable) {
        if (attempt === 6) throw cause
      }
    }
    if (attempt < 6) await delay(50 * 2 ** attempt, signal)
  }
  throw new RootError("conflict")
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => {
      clearTimeout(timer)
      reject(signal?.reason)
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted)
      resolve()
    }, milliseconds)
    if (signal?.aborted) aborted()
    else signal?.addEventListener("abort", aborted, { once: true })
  })
}

async function clearPrefixes(provider: SyncProvider.Adapter, prefixes: readonly string[], signal?: AbortSignal) {
  const objects = (
    await Promise.all(prefixes.map((prefix) => SyncProvider.listAllRecursive(provider, prefix, signal)))
  ).flat()
  for (const values of chunk(objects, 100)) {
    const result = await provider.deleteBatch(
      values.map((item) => ({ path: item.path, version: item.version })),
      signal,
    )
    if (result.some((item) => item.status === "conflict")) return false
  }
  return true
}

function chunk<A>(values: readonly A[], size: number) {
  return Array.from({ length: Math.ceil(values.length / size) }, (_, index) =>
    values.slice(index * size, (index + 1) * size),
  )
}

function encode(value: Manifest | Reset) {
  return encoder.encode(JSON.stringify(value))
}

function parse(value: Uint8Array): unknown {
  try {
    return JSON.parse(decoder.decode(value))
  } catch {
    throw new RootError("invalid")
  }
}

function equal(left: Uint8Array, right: Uint8Array) {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
}

function validatedInstanceID(value: string) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new RootError("invalid")
  return value
}

function validReset(reset: Reset) {
  validatedInstanceID(reset.resetID)
  return reset
}
