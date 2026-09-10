/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { createSignal, onCleanup } from "solid-js"
import { DialogProviderUsagePreferences, type ProviderUsagePreferenceStore } from "../../../src/component/dialog-model"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { KVProvider } from "../../../src/context/kv"
import { ThemeProvider } from "../../../src/context/theme"
import { TuiConfigProvider } from "../../../src/config"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { OpencodeKeymapProvider, registerOpencodeKeymap, type OpenTuiKeymap } from "../../../src/keymap"
import { summary, type Meter, type Result } from "../../../src/provider-usage"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

const meters: Meter[] = [
  {
    id: "quota",
    label: "5 hour limit",
    kind: "quota",
    remaining: 72,
    limit: 100,
    unit: "percentage",
    resetsAt: 1_700_006_960_000,
    order: 0,
  },
  {
    id: "requests",
    label: "Weekly limit",
    kind: "quota",
    remaining: 8,
    unit: "requests",
    resetsAt: 1_700_360_000_000,
    order: 1,
  },
]

const result: Result = {
  providerID: "openai",
  status: "available",
  snapshot: { providerID: "openai", source: "official_api", meters, fetchedAt: 1 },
}

test("usage dialog retains missing meters while toggle/reorder update the rendered footer", async () => {
  await using tmp = await tmpdir()
  const state = path.join(tmp.path, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")

  let keymap!: OpenTuiKeymap
  let saved = ["quota", "missing", "requests"]
  let readSaved = () => saved

  function Harness() {
    const renderer = useRenderer()
    keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const off = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(off)
    const [preference, setPreference] = createSignal(saved)
    readSaved = preference

    const usage: ProviderUsagePreferenceStore = {
      selected: (_providerID, available) => preference().filter((id) => available.includes(id)),
      saved: () => preference(),
      set: (_providerID, ids) => {
        saved = ids
        setPreference(ids)
      },
    }

    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state, worktree: tmp.path }}>
        <ClipboardProvider value={{}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <DialogProvider>
                      <box flexDirection="column">
                        <DialogProviderUsagePreferences providerID="openai" meters={meters} usage={usage} />
                        <text>
                          Footer{" "}
                          {summary(result, {
                            selected: usage.selected(
                              "openai",
                              meters.map((meter) => meter.id),
                            ),
                            now: 1_700_000_000_000,
                            compact: true,
                          })}
                        </text>
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

  const app = await testRender(() => <Harness />, { width: 70, height: 16, kittyKeyboard: true })
  try {
    for (let attempt = 0; attempt < 40 && !app.captureCharFrame().includes("Footer"); attempt++) {
      await Bun.sleep(10)
      await app.renderOnce()
    }
    expect(app.captureCharFrame()).toContain("Footer 5h 72% reset 1h56m · 7d 8 requests reset 4d4h")

    keymap.dispatchCommand("usage.move.down")
    keymap.dispatchCommand("usage.move.down")
    await app.renderOnce()
    expect(readSaved()).toEqual(["missing", "requests", "quota"])
    const reordered = app.captureCharFrame()
    expect(reordered.indexOf("Weekly limit")).toBeLessThan(reordered.indexOf("5 hour limit"))

    keymap.dispatchCommand("usage.toggle")
    await app.renderOnce()
    expect(readSaved()).toEqual(["missing", "quota"])
    expect(app.captureCharFrame()).toContain("Footer 5h 72% reset 1h56m")
  } finally {
    app.renderer.destroy()
  }
})
