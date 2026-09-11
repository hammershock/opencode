/** @jsxImportSource @opentui/solid */
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup } from "solid-js"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { DialogSelect } from "../../src/ui/dialog-select"
import { ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

// Scrollable selector ownership contract:
// - pointer motion may focus the visible row but must never reveal/scroll it;
// - keyboard navigation owns focus and may reveal it;
// - wheel input owns the viewport, and synthetic hover after layout must stay passive.
// If this fails, keep pointer handlers on the focus-only path. Do not call the
// keyboard move/reveal path from onMouseMove or onMouseOver. The normative rule
// lives under "Input, completion and focus" in docs/ui-design-guidelines.md.
test("DialogSelect separates pointer focus from keyboard and wheel scrolling", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const moved: number[] = []
  let keymap!: OpenTuiKeymap
  let setExternalCurrent!: (value: number) => void

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    const [current, setCurrent] = createSignal(0)
    setExternalCurrent = setCurrent
    onCleanup(off)

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ClipboardProvider value={{}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <box width="100%" height="100%">
                        <DialogSelect
                          title="Selector contract"
                          renderFilter={false}
                          current={current()}
                          options={Array.from({ length: 20 }, (_, index) => ({
                            title: `Option ${String(index).padStart(2, "0")}`,
                            value: index,
                          }))}
                          onMove={(option) => {
                            moved.push(option.value)
                            setCurrent(option.value)
                          }}
                        />
                      </box>
                    </DialogProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 70, height: 24, kittyKeyboard: true })
  try {
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    const scroll = findSelectionScroll(app.renderer.root)
    if (!scroll) throw new Error(`Expected DialogSelect scrollbox\n${app.captureCharFrame()}`)
    const initialScrollTop = scroll.scrollTop

    await app.mockMouse.moveTo(scroll.x + 5, scroll.y + 5)
    await app.renderOnce()
    await Bun.sleep(25)
    await app.renderOnce()
    expect(moved.at(-1)).toBe(5)
    expect(scroll.scrollTop).toBe(initialScrollTop)

    const beforeKeyboard = moved.length
    Array.from({ length: 8 }, () => keymap.dispatchCommand("dialog.select.next"))
    await app.renderOnce()
    expect(moved.length).toBe(beforeKeyboard + 8)
    expect(moved.slice(beforeKeyboard)).toEqual([6, 7, 8, 9, 10, 11, 12, 13])
    expect(scroll.scrollTop).toBeGreaterThan(initialScrollTop)

    const beforeWheel = moved.length
    const beforeWheelOffset = scroll.scrollTop
    await app.mockMouse.scroll(scroll.x + 5, scroll.y + 5, "down")
    await app.renderOnce()
    expect(scroll.scrollTop).toBeGreaterThan(beforeWheelOffset)
    expect(moved).toHaveLength(beforeWheel)

    const beforeExternal = moved.length
    setExternalCurrent(2)
    setExternalCurrent(19)
    await Bun.sleep(25)
    await app.renderOnce()
    expect(moved.slice(beforeExternal)).toEqual([19])
    expect(scroll.scrollTop).toBeGreaterThan(beforeWheelOffset)
  } finally {
    app.renderer.destroy()
  }
})

function findSelectionScroll(root: Renderable): ScrollBoxRenderable | undefined {
  if ("scrollTop" in root && "scrollHeight" in root && "viewport" in root) return root as ScrollBoxRenderable
  return root.getChildren().map(findSelectionScroll).find(Boolean)
}
