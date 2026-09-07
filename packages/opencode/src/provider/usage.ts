import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { NonNegativeInt } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import { Context, Effect, Layer, Schema } from "effect"
import { ProviderUsageAdapters } from "./usage-adapters"
import type { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"

export const Source = Schema.Literals(["official_api", "response_headers", "experimental_private"])
export type Source = typeof Source.Type

export const MeterKind = Schema.Literals(["balance", "quota", "rate_limit", "credits", "custom"])
export type MeterKind = typeof MeterKind.Type

export class Meter extends Schema.Class<Meter>("ProviderUsageMeter")({
  id: Schema.String,
  label: Schema.String,
  kind: MeterKind,
  used: Schema.optional(Schema.Finite),
  remaining: Schema.optional(Schema.Finite),
  limit: Schema.optional(Schema.Finite),
  unit: Schema.String,
  resetsAt: Schema.optional(NonNegativeInt),
  order: Schema.Finite,
}) {}

export class Snapshot extends Schema.Class<Snapshot>("ProviderUsageSnapshot")({
  providerID: Schema.String,
  accountID: Schema.optional(Schema.String),
  scopeID: Schema.optional(Schema.String),
  fetchedAt: NonNegativeInt,
  expiresAt: Schema.optional(NonNegativeInt),
  source: Source,
  meters: Schema.Array(Meter),
}) {}

export const Status = Schema.Literals(["available", "unsupported", "unauthenticated", "error", "stale"])
export type Status = typeof Status.Type

export const FailureKind = Schema.Literals(["authentication", "rate_limit", "timeout", "schema", "network", "unknown"])
export type FailureKind = typeof FailureKind.Type

export class AdapterError extends Schema.TaggedErrorClass<AdapterError>()("ProviderUsageAdapterError", {
  kind: FailureKind,
}) {}

export class Result extends Schema.Class<Result>("ProviderUsageResult")({
  providerID: Schema.String,
  status: Status,
  snapshot: Schema.optional(Snapshot),
  error: Schema.optional(FailureKind),
}) {}

export type Probe =
  | { readonly status: "unsupported" }
  | {
      readonly status: "ready"
      readonly accountID?: string
      readonly scopeID?: string
    }

export interface Adapter {
  readonly providerID: string
  readonly ttlMs?: number
  readonly probe: (input: { readonly auth: Auth.Info; readonly providerConfig?: ConfigProviderV1.Info }) => Probe
  readonly fetch: (input: {
    readonly auth: Auth.Info
    readonly providerConfig?: ConfigProviderV1.Info
    readonly accountID?: string
    readonly scopeID?: string
    readonly signal: AbortSignal
  }) => Promise<Snapshot>
}

export interface Query {
  readonly providerID: string
  readonly refresh?: boolean
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly query: (input: Query) => Effect.Effect<Result, Auth.AuthError>
  readonly queryAll: (providerIDs: readonly string[]) => Effect.Effect<readonly Result[], Auth.AuthError>
  readonly invalidate: (providerID?: string) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ProviderUsage") {}

type Cache = {
  readonly providerID: string
  readonly auth: string
  readonly result: Result
  readonly expiresAt: number
}

type Inflight = {
  readonly providerID: string
  readonly auth: string
  readonly controller: AbortController
  readonly promise: Promise<Result>
  waiters: number
}

const DEFAULT_TTL = 60_000
const MAX_TTL = 5 * 60_000

export function layer(
  adapters: readonly Adapter[],
  options?: { readonly concurrency?: number; readonly now?: () => number },
) {
  return Layer.effect(
    Service,
    Effect.gen(function* () {
      const auth = yield* Auth.Service
      const config = yield* Config.Service
      const registry = new Map(adapters.map((adapter) => [adapter.providerID, adapter]))
      const cache = new Map<string, Cache>()
      const inflight = new Map<string, Inflight>()
      const identities = new Map<string, string>()
      const concurrency = Math.max(1, Math.floor(options?.concurrency ?? 4))
      const now = options?.now ?? Date.now
      const queue: Array<() => void> = []
      let active = 0

      const schedule = async <A>(run: () => Promise<A>) => {
        if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve))
        active++
        return run().finally(() => {
          active--
          queue.shift()?.()
        })
      }

      const wait = (key: string, item: Inflight, external?: AbortSignal) =>
        Effect.tryPromise(
          (signal) =>
            new Promise<Result>((resolve, reject) => {
              item.waiters++
              let settled = false
              const cancel = () => {
                if (settled) return
                settled = true
                signal.removeEventListener("abort", cancel)
                external?.removeEventListener("abort", cancel)
                item.waiters--
                if (item.waiters === 0) {
                  item.controller.abort()
                  if (inflight.get(key) === item) inflight.delete(key)
                }
                reject(signal.reason)
              }
              signal.addEventListener("abort", cancel, { once: true })
              external?.addEventListener("abort", cancel, { once: true })
              if (external?.aborted) cancel()
              item.promise.then(
                (result) => {
                  if (settled) return
                  settled = true
                  signal.removeEventListener("abort", cancel)
                  external?.removeEventListener("abort", cancel)
                  item.waiters--
                  resolve(result)
                },
                (cause) => {
                  if (settled) return
                  settled = true
                  signal.removeEventListener("abort", cancel)
                  external?.removeEventListener("abort", cancel)
                  item.waiters--
                  reject(cause)
                },
              )
            }),
        ).pipe(Effect.orDie)

      const query = Effect.fn("ProviderUsage.query")(function* (input: Query) {
        const adapter = registry.get(input.providerID)
        if (!adapter) return new Result({ providerID: input.providerID, status: "unsupported" })

        const credential = yield* auth.get(input.providerID)
        if (!credential) {
          clearProvider(input.providerID, cache, inflight)
          identities.delete(input.providerID)
          return new Result({ providerID: input.providerID, status: "unauthenticated" })
        }

        const providerConfig = (yield* config.get()).provider?.[input.providerID]
        const authID = Hash.fast(JSON.stringify([credential, providerConfig ?? null]))
        if (identities.get(input.providerID) !== authID) {
          clearProvider(input.providerID, cache, inflight)
          identities.set(input.providerID, authID)
        }
        const probe = adapter.probe({ auth: credential, providerConfig })
        if (probe.status === "unsupported") return new Result({ providerID: input.providerID, status: "unsupported" })

        const key = JSON.stringify([input.providerID, probe.accountID ?? "", probe.scopeID ?? ""])
        const cached = cache.get(key)
        const valid = cached?.auth === authID ? cached : undefined
        if (!valid) cache.delete(key)
        if (!input.refresh && valid && valid.expiresAt > now()) return valid.result

        const running = inflight.get(key)
        if (running?.auth === authID) return yield* wait(key, running, input.signal)
        if (running) {
          running.controller.abort()
          inflight.delete(key)
        }

        const controller = new AbortController()
        const item: Inflight = {
          providerID: input.providerID,
          auth: authID,
          controller,
          promise: Promise.resolve(undefined as never),
          waiters: 0,
        }
        const promise = schedule(() =>
          adapter.fetch({
            auth: credential,
            providerConfig,
            accountID: probe.accountID,
            scopeID: probe.scopeID,
            signal: controller.signal,
          }),
        )
          .then((snapshot) => {
            const result = new Result({ providerID: input.providerID, status: "available", snapshot })
            cache.set(key, {
              providerID: input.providerID,
              auth: authID,
              result,
              expiresAt: Math.min(
                snapshot.expiresAt ?? now() + Math.max(0, adapter.ttlMs ?? DEFAULT_TTL),
                now() + MAX_TTL,
              ),
            })
            return result
          })
          .catch((cause) => {
            if (controller.signal.aborted) throw cause
            const stale = cache.get(key)
            return new Result({
              providerID: input.providerID,
              status: stale?.auth === authID ? "stale" : "error",
              ...(stale?.auth === authID ? { snapshot: stale.result.snapshot } : {}),
              error: safeError(cause),
            })
          })
          .finally(() => {
            if (inflight.get(key) === item) inflight.delete(key)
          })
        Object.assign(item, { promise })
        inflight.set(key, item)
        return yield* wait(key, item, input.signal)
      })

      const queryAll = Effect.fn("ProviderUsage.queryAll")((providerIDs: readonly string[]) =>
        Effect.all(
          providerIDs.map((providerID) => query({ providerID })),
          { concurrency: "unbounded" },
        ),
      )

      const invalidate = Effect.fn("ProviderUsage.invalidate")((providerID?: string) =>
        Effect.sync(() => {
          if (providerID) {
            clearProvider(providerID, cache, inflight)
            identities.delete(providerID)
            return
          }
          for (const item of inflight.values()) item.controller.abort()
          inflight.clear()
          cache.clear()
          identities.clear()
        }),
      )

      return Service.of({ query, queryAll, invalidate })
    }),
  )
}

function safeError(cause: unknown) {
  if (cause instanceof AdapterError) return cause.kind
  if (cause instanceof DOMException && cause.name === "TimeoutError") return "timeout"
  return "unknown"
}

function clearProvider(providerID: string, cache: Map<string, Cache>, inflight: Map<string, Inflight>) {
  for (const [key, item] of inflight) {
    if (item.providerID !== providerID) continue
    item.controller.abort()
    inflight.delete(key)
  }
  for (const [key, item] of cache) {
    if (item.providerID === providerID) cache.delete(key)
  }
}

export const defaultLayer = Layer.unwrap(Effect.sync(() => layer(ProviderUsageAdapters.defaults.adapters)))
export const node = LayerNode.make({ service: Service, layer: defaultLayer, deps: [Auth.node, Config.node] })

export * as ProviderUsage from "./usage"
