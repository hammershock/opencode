/** @jsxImportSource @opentui/solid */
import type { Renderable, ScrollBoxRenderable } from "@opentui/core"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup } from "solid-js"
import { DialogModelContextPreview } from "../../src/component/dialog-model-context"
import { TuiConfigProvider } from "../../src/config"
import { ClipboardProvider } from "../../src/context/clipboard"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../src/keymap"
import { DialogProvider } from "../../src/ui/dialog"
import { Toast, ToastProvider } from "../../src/ui/toast"
import { tmpdir } from "../fixture/fixture"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"

test("model context preview scrolls long sources and copies the complete source with its configured shortcut", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  const content = Array.from({ length: 40 }, (_, index) => `context line ${String(index + 1).padStart(2, "0")}`).join(
    "\n",
  )
  const copied: string[] = []
  let failCopy = false
  let keymap!: OpenTuiKeymap

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig({
      keybinds: {
        "dialog.model_context.line_up": "k",
        "dialog.model_context.line_down": "j",
        "dialog.model_context.copy": "ctrl+y",
      },
    })
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ClipboardProvider
          value={{
            write: async (value) => {
              if (failCopy) throw new Error("clipboard failed")
              copied.push(value)
            },
          }}
        >
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <DialogModelContextPreview title="AGENTS.md" content={content} />
                    </DialogProvider>
                    <Toast />
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
    const scroll = findScroll(app.renderer.root)
    if (!scroll) throw new Error(`Expected model context scrollbox\n${app.captureCharFrame()}`)
    expect(scroll.scrollHeight).toBeGreaterThan(scroll.viewport.height)
    expect(app.captureCharFrame()).toContain("context line 01")
    expect(app.captureCharFrame()).not.toContain("context line 40")

    keymap.dispatchCommand("dialog.model_context.page_down")
    await app.renderOnce()
    expect(scroll.scrollTop).toBeGreaterThan(0)

    keymap.dispatchCommand("dialog.model_context.end")
    await app.renderOnce()
    expect(app.captureCharFrame()).toContain("context line 40")

    keymap.dispatchCommand("dialog.model_context.home")
    await app.renderOnce()
    expect(scroll.scrollTop).toBe(0)

    await app.mockMouse.scroll(scroll.x + 5, scroll.y + 5, "down")
    await app.renderOnce()
    expect(scroll.scrollTop).toBeGreaterThan(0)

    app.mockInput.pressKey("y", { ctrl: true })
    await Promise.resolve()
    await app.renderOnce()
    expect(copied).toEqual([content])
    expect(app.captureCharFrame()).toContain("Context source copied to clipboard")
    expect(app.captureCharFrame()).toContain("copied ctrl+y")
    expect(app.captureCharFrame()).toMatch(/k.*j.*scroll/)

    failCopy = true
    app.mockInput.pressKey("y", { ctrl: true })
    await Promise.resolve()
    await app.renderOnce()
    expect(copied).toEqual([content])
    expect(app.captureCharFrame()).toContain("Failed to copy context source")
    expect(app.captureCharFrame()).toContain("copy ctrl+y")
  } finally {
    app.renderer.destroy()
  }
})

function findScroll(root: Renderable): ScrollBoxRenderable | undefined {
  if ("scrollTop" in root && "scrollHeight" in root && "viewport" in root) return root as ScrollBoxRenderable
  return root.getChildren().map(findScroll).find(Boolean)
}
