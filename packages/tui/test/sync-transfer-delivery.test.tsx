import { expect, mock, test } from "bun:test"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

test("renders active sync transfer events and clears the summary on idle", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start() {
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    await setup.waitForVisualIdle()

    events.emit({
      directory,
      payload: {
        id: "evt_transfer_active",
        type: "sync.transfer.updated",
        properties: {
          progress: { state: "active", direction: "upload", phase: "sessions", items: 2, bytes: 1_536 },
        },
      },
    })
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).toContain("◐ Sync · synchronize · ↑ sessions · 2 · 1.5 KB")

    events.emit({
      directory,
      payload: {
        id: "evt_transfer_idle",
        type: "sync.transfer.updated",
        properties: { progress: { state: "idle" } },
      },
    })
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("◐ Sync · synchronize")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
