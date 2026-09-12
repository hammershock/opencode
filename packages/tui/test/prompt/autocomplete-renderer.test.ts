import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { ScrollBoxRenderable, TextareaRenderable, type Renderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "../fixture/tui-sdk"

test("Skill autocomplete keeps complete single-line rows horizontally scrollable", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const skills = Array.from({ length: 10 }, (_, index) => ({
    id: `skl_${String(index).padStart(64, "0")}`,
    name: index === 0 ? `skill-${"wide".repeat(30)}` : `skill-${String(index).padStart(2, "0")}`,
    description: index === 0 ? "Long descriptions must stay on the same candidate row.".repeat(4) : `Skill ${index}`,
    sourceLabel: "OpenCode config",
    digest: `digest-${index}`,
  }))
  const calls = createFetch((url) => {
    if (url.pathname === "/agent")
      return json([{ name: "build", mode: "primary", hidden: false, permission: [], options: {} }])
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/api/skill/catalog")
      return json({
        location: { target: { type: "local" }, directory: "/tmp/opencode", project: { id: "test", directory } },
        data: { revision: "catalog", digest: "catalog", skills, diagnostics: [] },
      })
    return undefined
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}

  try {
    const { run } = await import("../../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: {},
        pluginHost: {
          async start(input) {
            api = input.api
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            started()
          },
          async dispose() {
            disposeSlots()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    const editor = setup.renderer.currentFocusedEditor
    expect(editor).toBeInstanceOf(TextareaRenderable)
    setup.mockInput.pressKey("$")
    await waitForFrame(setup, "1/10")
    const scroll = findAutocompleteScroll(setup.renderer.root)
    expect(scroll).toBeDefined()
    expect(scroll!.getChildren().map((option) => option.height)).toEqual(Array(10).fill(1))
    expect(scroll!.scrollWidth).toBeGreaterThan(scroll!.viewport.width)
    await setup.mockMouse.scroll(scroll!.x + 2, scroll!.y + 1, "right")
    await setup.waitForVisualIdle()
    expect(scroll!.scrollLeft).toBeGreaterThan(0)
    scroll!.scrollLeft = scroll!.scrollWidth
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).toContain("candidate row.")
    scroll!.scrollLeft = 0
    const initialScrollTop = scroll!.scrollTop
    await setup.mockMouse.moveTo(scroll!.x + 2, scroll!.y + 4)
    await setup.waitForVisualIdle()
    expect(scroll!.scrollTop).toBe(initialScrollTop)
    expect(setup.captureCharFrame()).toContain("5/10")

    // Filtering relayouts can synthesize hover transitions under a stationary pointer.
    // They must not take ownership from the reset selection or move the viewport.
    setup.mockInput.pressKey("x")
    setup.mockInput.pressBackspace()
    await waitForFrame(setup, "1/10")
    expect(scroll!.scrollTop).toBe(0)

    await setup.mockMouse.scroll(scroll!.x + 2, scroll!.y + 4, "down")
    await setup.waitForVisualIdle()
    expect(scroll!.scrollTop).toBeGreaterThan(0)
    expect(setup.captureCharFrame()).toContain(`${Math.floor(scroll!.scrollTop) + 1}/10`)

    setup.mockInput.pressKey("x")
    setup.mockInput.pressBackspace()
    await waitForFrame(setup, "1/10")
    expect(scroll!.scrollTop).toBe(0)

    for (const selected of [2, 3, 4, 5, 6, 7, 8, 9, 10, 1, 2, 3]) {
      setup.mockInput.pressArrow("down")
      await waitForFrame(setup, `${selected}/10`)
      expectSelectionVisible(scroll!, selected - 1)
    }

    for (const selected of [2, 1, 10, 9]) {
      setup.mockInput.pressArrow("up")
      await waitForFrame(setup, `${selected}/10`)
      expectSelectionVisible(scroll!, selected - 1)
    }

    api?.keymap.dispatchCommand("app.exit")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

async function waitForFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}\n${setup.captureCharFrame()}`)
}

function findAutocompleteScroll(root: Renderable): ScrollBoxRenderable | undefined {
  if (root instanceof ScrollBoxRenderable && root.scrollHeight === 10 && root.viewport.height === 8) return root
  return root.getChildren().map(findAutocompleteScroll).find(Boolean)
}

function expectSelectionVisible(scroll: ScrollBoxRenderable, index: number) {
  const option = scroll.getChildren()[index]
  expect(option, `Missing autocomplete option ${index}`).toBeDefined()
  expect(option!.y, `Option ${index} starts above the viewport`).toBeGreaterThanOrEqual(scroll.viewport.y)
  expect(option!.y + option!.height, `Option ${index} ends below the viewport`).toBeLessThanOrEqual(
    scroll.viewport.y + scroll.viewport.height,
  )
}
