import { describe, expect, test } from "bun:test"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Location } from "@opencode-ai/core/location"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { Pty } from "@opencode-ai/core/pty"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Context, Effect, Exit, Fiber, Layer } from "effect"
import type { RexdLease } from "../../src/rexd/connection"
import { rexdPtyNode } from "../../src/rexd/location-pty"
import { rexdSessionNode, RexdLocationSession } from "../../src/rexd/location-session"

describe("Rexd Location PTY environment", () => {
  test("marks existing PTYs stale and atomically restarts with the current target generation", async () => {
    const calls: Array<{ method: string; params: Record<string, unknown> }> = []
    let opened = 0
    let failClose = false
    let openGate: { started: PromiseWithResolvers<void>; release: PromiseWithResolvers<void> } | undefined
    const lease = {
      handshake: { sessionID: "remote-session", workspaceRoots: ["/workspace"] },
      client: {
        onNotification() {
          return () => undefined
        },
        onClose() {
          return () => undefined
        },
        async request(method: string, params: Record<string, unknown>) {
          calls.push({ method, params })
          if (method === "pty.open") {
            opened += 1
            const gate = openGate
            if (gate) {
              gate.started.resolve()
              await gate.release.promise
            }
            return { pty_id: `remote-pty-${opened}`, process_id: `remote-process-${opened}` }
          }
          if (method === "pty.close") {
            if (failClose) {
              failClose = false
              throw new Error("remote close failed")
            }
            return { ok: true }
          }
          throw new Error(`unexpected RPC ${method}`)
        },
      },
    } as unknown as RexdLease

    let generation = 1
    let value = "one"
    const listeners = new Set<(next: number) => void>()
    const environment = Layer.mock(LocationEnvironment.Service)({
      snapshot: () =>
        Effect.succeed({
          enabled: true,
          generation,
          values: Object.freeze({ REMOTE_GENERATION: value }),
          variables: [],
          sources: [],
        }),
      reload: () => Effect.die("not used"),
      environment: (explicit = {}) => Effect.succeed({ REMOTE_GENERATION: value, ...explicit }),
      list: () => Effect.succeed({ enabled: true, generation, variables: [], sources: [] }),
      reveal: () => Effect.succeed({ values: () => ({}), close: () => undefined }),
      ensureTemplate: () => Effect.succeed("existing" as const),
      subscribe: (listener) =>
        Effect.sync(() => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }),
    })
    const targetID = Location.TargetID.make("00000000-0000-4000-8000-000000000087")
    const ref = Location.Ref.make({
      target: { type: "rexd", targetID },
      directory: AbsolutePath.make("/workspace"),
    })
    const location = Layer.succeed(
      Location.Service,
      Location.Service.of({
        ...ref,
        workspaceID: "workspace" as never,
        project: { id: "project" as never, directory: AbsolutePath.make("/workspace") },
      }),
    )
    const session = rexdSessionNode(ref)
    const node = rexdPtyNode(session)
    const testLayer = AppNodeBuilder.build(LayerNode.group([node]), [
      [session, Layer.succeed(RexdLocationSession, lease)],
      [Location.node, location],
      [LocationEnvironment.node, environment],
    ])

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const pty = yield* Pty.Service
          const original = yield* pty.create({ command: "/bin/sh", cwd: "/workspace", title: "remote" })
          expect(original.environmentGeneration).toBe(1)
          expect(original.environmentStale).toBe(false)
          expect(calls.find((call) => call.method === "pty.open")?.params.env).toMatchObject({
            REMOTE_GENERATION: "one",
          })

          generation = 2
          value = "two"
          listeners.forEach((listener) => listener(generation))
          expect((yield* pty.get(original.id)).environmentStale).toBe(true)

          const replacement = yield* pty.restart(original.id)
          expect(replacement.id).not.toBe(original.id)
          expect(replacement.environmentGeneration).toBe(2)
          expect(replacement.environmentStale).toBe(false)
          expect(calls.filter((call) => call.method === "pty.open").at(-1)?.params.env).toMatchObject({
            REMOTE_GENERATION: "two",
          })

          openGate = { started: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }
          const concurrent = yield* pty.restart(replacement.id).pipe(Effect.forkScoped)
          yield* Effect.promise(() => openGate!.started.promise)
          generation = 3
          value = "three"
          listeners.forEach((listener) => listener(generation))
          openGate.release.resolve()
          const raced = yield* Fiber.join(concurrent)
          openGate = undefined
          expect(raced.environmentGeneration).toBe(2)
          expect(raced.environmentStale).toBe(true)

          failClose = true
          const failed = yield* pty.restart(raced.id).pipe(Effect.exit)
          expect(Exit.isFailure(failed)).toBe(true)
          expect((yield* pty.get(raced.id)).status).toBe("running")
        }).pipe(Effect.provide(testLayer)),
      ),
    )
  })
})
