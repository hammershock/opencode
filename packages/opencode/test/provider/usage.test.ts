import { describe, expect, test } from "bun:test"
import { Auth } from "@/auth"
import { Config } from "@/config/config"
import type { ConfigProviderV1 } from "@opencode-ai/core/v1/config/provider"
import { ProviderUsage } from "@/provider/usage"
import { Deferred, Effect, Fiber, Layer, Schema } from "effect"

const credential = new Auth.Api({ type: "api", key: "managed-secret" })

function authLayer(get: () => Auth.Info | undefined = () => credential) {
  return Layer.merge(
    Layer.mock(Auth.Service, {
      get: (providerID) => Effect.succeed(providerID === "test" ? get() : undefined),
    }),
    configLayer(),
  )
}

function configLayer(get: () => { provider?: Record<string, ConfigProviderV1.Info> } = () => ({})) {
  return Layer.mock(Config.Service, {
    get: () => Effect.succeed(get()),
  })
}

function snapshot(fetchedAt = 1) {
  return new ProviderUsage.Snapshot({
    providerID: "test",
    fetchedAt,
    source: "official_api",
    meters: [
      new ProviderUsage.Meter({
        id: "balance",
        label: "Balance",
        kind: "balance",
        remaining: 12,
        unit: "credits",
        order: 0,
      }),
    ],
  })
}

describe("provider usage", () => {
  test("distinguishes unsupported and unauthenticated without fetching", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const unsupported = yield* ProviderUsage.Service.pipe(
          Effect.flatMap((service) => service.query({ providerID: "missing" })),
          Effect.provide(ProviderUsage.layer([])),
          Effect.provide(authLayer()),
        )
        expect(unsupported.status).toBe("unsupported")

        const unauthenticated = yield* ProviderUsage.Service.pipe(
          Effect.flatMap((service) => service.query({ providerID: "test" })),
          Effect.provide(
            ProviderUsage.layer([
              {
                providerID: "test",
                probe: () => ({ status: "ready" }),
                fetch: () => Promise.resolve(snapshot()),
              },
            ]),
          ),
          Effect.provide(authLayer(() => undefined)),
        )
        expect(unauthenticated.status).toBe("unauthenticated")
      }),
    ))

  test("passes only the credential owned by OpenCode auth", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let seen: Auth.Info | undefined
        const result = yield* ProviderUsage.Service.pipe(
          Effect.flatMap((service) => service.query({ providerID: "test" })),
          Effect.provide(
            ProviderUsage.layer([
              {
                providerID: "test",
                probe: ({ auth }) => {
                  seen = auth
                  return { status: "ready" }
                },
                fetch: () => Promise.resolve(snapshot()),
              },
            ]),
          ),
          Effect.provide(authLayer()),
        )
        expect(result.status).toBe("available")
        expect(seen).toBe(credential)
      }),
    ))

  test("coalesces concurrent requests and supports refresh", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let calls = 0
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: () => ({ status: "ready" }),
            fetch: async () => {
              calls++
              return snapshot(calls)
            },
          },
        ]).pipe(Layer.provide(authLayer()))
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        const first = yield* Effect.all(
          [service.query({ providerID: "test" }), service.query({ providerID: "test" })],
          { concurrency: "unbounded" },
        )
        expect(first.map((item) => item.status)).toEqual(["available", "available"])
        expect(calls).toBe(1)
        yield* service.query({ providerID: "test" })
        expect(calls).toBe(1)
        yield* service.query({ providerID: "test", refresh: true })
        expect(calls).toBe(2)
      }),
    ))

  test("keeps stale success after isolated adapter failure", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let fail = false
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: () => ({ status: "ready" }),
            fetch: () =>
              fail ? Promise.reject(new ProviderUsage.AdapterError({ kind: "schema" })) : Promise.resolve(snapshot()),
          },
        ]).pipe(Layer.provide(authLayer()))
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        expect((yield* service.query({ providerID: "test" })).status).toBe("available")
        fail = true
        const result = yield* service.query({ providerID: "test", refresh: true })
        expect(result.status).toBe("stale")
        expect(result.snapshot?.meters[0]?.remaining).toBe(12)
        expect(result.error).toBe("schema")
      }),
    ))

  test("isolates provider failures in a concurrent probe", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: () => ({ status: "ready" }),
            fetch: () => Promise.reject(new ProviderUsage.AdapterError({ kind: "network" })),
          },
          {
            providerID: "healthy",
            probe: () => ({ status: "ready" }),
            fetch: () => Promise.resolve(new ProviderUsage.Snapshot({ ...snapshot(), providerID: "healthy" })),
          },
        ]).pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(Auth.Service, {
                get: () => Effect.succeed(credential),
              }),
              configLayer(),
            ),
          ),
        )
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        const result = yield* service.queryAll(["test", "healthy"])
        expect(result.map((item) => item.status)).toEqual(["error", "available"])
        expect(result[0]?.error).toBe("network")
      }),
    ))

  test("limits adapter concurrency across providers", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const firstWave = yield* Deferred.make<void>()
        const secondWave = yield* Deferred.make<void>()
        const releases: Array<() => void> = []
        let active = 0
        let maximum = 0
        let started = 0
        const adapters = ["one", "two", "three"].map((providerID) => ({
          providerID,
          probe: () => ({ status: "ready" as const }),
          fetch: () =>
            new Promise<ProviderUsage.Snapshot>((resolve) => {
              active++
              started++
              maximum = Math.max(maximum, active)
              releases.push(() => {
                active--
                resolve(new ProviderUsage.Snapshot({ ...snapshot(), providerID }))
              })
              if (started === 2) Effect.runSync(Deferred.succeed(firstWave, undefined))
              if (started === 3) Effect.runSync(Deferred.succeed(secondWave, undefined))
            }),
        }))
        const layer = ProviderUsage.layer(adapters, { concurrency: 2 }).pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(Auth.Service, {
                get: () => Effect.succeed(credential),
              }),
              configLayer(),
            ),
          ),
        )
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        const query = yield* service.queryAll(["one", "two", "three"]).pipe(Effect.forkChild)
        yield* Deferred.await(firstWave)
        expect(maximum).toBe(2)
        releases.shift()?.()
        yield* Deferred.await(secondWave)
        expect(maximum).toBe(2)
        releases.splice(0).forEach((release) => release())
        yield* Fiber.await(query)
      }),
    ))

  test("serializes only redacted usage data", () => {
    const value = Schema.encodeSync(ProviderUsage.Result)(
      new ProviderUsage.Result({ providerID: "test", status: "available", snapshot: snapshot() }),
    )
    expect(JSON.stringify(value)).not.toContain(credential.key)
    expect(Object.keys(value).sort()).toEqual(["providerID", "snapshot", "status"])
  })

  test("invalidates cache when OpenCode auth changes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let current: Auth.Info = credential
        let calls = 0
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: () => ({ status: "ready" }),
            fetch: () => {
              calls++
              return Promise.resolve(snapshot(calls))
            },
          },
        ]).pipe(Layer.provide(authLayer(() => current)))
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        yield* service.query({ providerID: "test" })
        current = new Auth.Api({ type: "api", key: "replacement" })
        yield* service.query({ providerID: "test" })
        expect(calls).toBe(2)
      }),
    ))

  test("invalidates cache and forwards resolved provider config when its identity changes", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let baseURL = "https://one.example"
        const seen: unknown[] = []
        let calls = 0
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: ({ providerConfig }) => {
              seen.push(providerConfig)
              return { status: "ready" }
            },
            fetch: ({ providerConfig }) => {
              seen.push(providerConfig)
              calls++
              return Promise.resolve(snapshot(calls))
            },
          },
        ]).pipe(
          Layer.provide(
            Layer.merge(
              Layer.mock(Auth.Service, { get: () => Effect.succeed(credential) }),
              configLayer(() => ({ provider: { test: { options: { baseURL } } } })),
            ),
          ),
        )
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        yield* service.query({ providerID: "test" })
        yield* service.query({ providerID: "test" })
        expect(calls).toBe(1)
        baseURL = "https://two.example"
        yield* service.query({ providerID: "test" })
        expect(calls).toBe(2)
        expect(seen).toContainEqual({ options: { baseURL: "https://two.example" } })
      }),
    ))

  test("purges cached snapshots when an account disconnects", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        let current: Auth.Info | undefined = credential
        let calls = 0
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: () => ({ status: "ready" }),
            fetch: () => {
              calls++
              return Promise.resolve(snapshot(calls))
            },
          },
        ]).pipe(Layer.provide(authLayer(() => current)))
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        yield* service.query({ providerID: "test" })
        current = undefined
        expect((yield* service.query({ providerID: "test" })).status).toBe("unauthenticated")
        current = credential
        yield* service.query({ providerID: "test" })
        expect(calls).toBe(2)
      }),
    ))

  test("keeps a coalesced fetch alive until every consumer cancels", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>()
        const joined = yield* Deferred.make<void>()
        const restarted = yield* Deferred.make<void>()
        let probes = 0
        let complete: ((value: ProviderUsage.Snapshot) => void) | undefined
        let aborted = false
        const layer = ProviderUsage.layer([
          {
            providerID: "test",
            probe: () => {
              probes++
              if (probes === 2) Effect.runSync(Deferred.succeed(joined, undefined))
              if (probes === 3) Effect.runSync(Deferred.succeed(restarted, undefined))
              return { status: "ready" }
            },
            fetch: ({ signal }) =>
              new Promise((resolve, reject) => {
                complete = resolve
                Effect.runSync(Deferred.succeed(started, undefined))
                signal.addEventListener("abort", () => {
                  aborted = true
                  reject(signal.reason)
                })
              }),
          },
        ]).pipe(Layer.provide(authLayer()))
        const service = yield* ProviderUsage.Service.pipe(Effect.provide(layer))
        const firstController = new AbortController()
        const secondController = new AbortController()
        const first = yield* service
          .query({ providerID: "test", signal: firstController.signal })
          .pipe(Effect.forkChild)
        const second = yield* service
          .query({ providerID: "test", signal: secondController.signal })
          .pipe(Effect.forkChild)
        yield* Deferred.await(started)
        yield* Deferred.await(joined)
        yield* Effect.yieldNow
        firstController.abort()
        yield* Fiber.await(first)
        expect(aborted).toBe(false)
        complete?.(snapshot())
        const secondExit = yield* Fiber.await(second)
        expect(secondExit._tag).toBe("Success")
        expect(aborted).toBe(false)

        const thirdController = new AbortController()
        const third = yield* service
          .query({ providerID: "test", refresh: true, signal: thirdController.signal })
          .pipe(Effect.forkChild)
        yield* Deferred.await(restarted)
        yield* Effect.yieldNow
        thirdController.abort()
        yield* Fiber.await(third)
        expect(aborted).toBe(true)
      }),
    ))
})
