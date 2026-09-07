/** @jsxImportSource @opentui/solid */
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { testRender, useRenderer } from "@opentui/solid"
import { expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { onCleanup, onMount } from "solid-js"
import { TuiConfigProvider } from "../../../src/config"
import { ClipboardProvider } from "../../../src/context/clipboard"
import { KVProvider } from "../../../src/context/kv"
import { SDKProvider } from "../../../src/context/sdk"
import { SyncSettingsProvider, useSyncSettings } from "../../../src/context/sync-settings"
import { ThemeProvider } from "../../../src/context/theme"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../../src/keymap"
import { DialogProvider } from "../../../src/ui/dialog"
import { ToastProvider } from "../../../src/ui/toast"
import { tmpdir } from "../../fixture/fixture"
import { TestTuiContexts } from "../../fixture/tui-environment"
import { eventSource, json } from "../../fixture/tui-sdk"
import { createTuiResolvedConfig } from "../../fixture/tui-runtime"

async function wait(label: string, fn: () => boolean | Promise<boolean>, timeout = 2_000) {
  const started = performance.now()
  while (!(await fn())) {
    if (performance.now() - started > timeout) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

test("opens from local state while a remote refresh is slow", async () => {
  await using tmp = await tmpdir()
  const stateDirectory = path.join(tmp.path, "state")
  await mkdir(stateDirectory, { recursive: true })
  await Bun.write(path.join(stateDirectory, "kv.json"), "{}")

  let state = {
    version: 2,
    revision: 0,
    provider: "baidu",
    deviceID: "device-local",
    deviceName: "Local device",
    account: { id: "account-local", maskedDisplay: "lo***@example.com" },
    activeSpaceID: "space-local",
    enabled: true,
    intervalSeconds: 30,
    spaces: [
      {
        accountID: "account-local",
        descriptor: {
          namespaceID: "space-local",
          name: "Local space",
          protocol: { major: 1, minor: 0 },
          encryption: "none",
          createdAt: 1,
          updatedAt: 2,
          summary: { sessions: 3, devices: 2, updatedAt: 2 },
          revision: 0,
        },
        remoteRoot: "/apps/opencode-sync/spaces/space-local",
        joinedAt: 1,
      },
    ],
  }
  const calls: Array<{ method: string; path: string }> = []
  let releaseStatus!: () => void
  let statusUnavailable = false
  const remoteSpaces = Array.from({ length: 6 }, (_, index) => ({
    status: "compatible",
    descriptor: {
      namespaceID: `space-remote-${index}`,
      name: `Remote ${index}`,
      protocol: { major: 1, minor: 0 },
      encryption: "none",
      createdAt: 1,
      updatedAt: 2,
      summary: { sessions: 0, devices: 0, updatedAt: 2 },
      revision: 0,
    },
  }))
  let discoveryCalls = 0
  let delayNextDiscovery = false
  const statusGate = new Promise<void>((resolve) => {
    releaseStatus = resolve
  })
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init)
    const url = new URL(request.url)
    calls.push({ method: request.method, path: url.pathname })
    if (url.pathname === "/global/sync/state") return json(state)
    if (url.pathname === "/global/sync/enabled" && request.method === "PATCH") {
      const body = (await request.json()) as { enabled: boolean }
      state = { ...state, enabled: body.enabled }
      return json(state)
    }
    if (url.pathname === "/global/sync/status") {
      await statusGate
      if (statusUnavailable) return new Response(null, { status: 503 })
      return json({
        configured: true,
        initialized: true,
        authenticated: true,
        enabled: true,
        locked: false,
        provider: "baidu",
        namespaceID: "space-local",
        deviceID: "device-local",
        account: state.account,
        activeSpace: { namespaceID: "space-local", name: "Local space", encryption: "none" },
        intervalSeconds: 30,
        outbox: 0,
        cursors: {},
      })
    }
    if (url.pathname === "/global/sync/spaces") {
      discoveryCalls++
      if (delayNextDiscovery) {
        delayNextDiscovery = false
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
        return new Response(null, { status: 503 })
      }
      return json({ account: state.account, spaces: remoteSpaces })
    }
    if (url.pathname === "/global/sync/sessions") return json([])
    if (url.pathname === "/global/sync/devices")
      return json({ namespaceID: "space-local", devices: [], acknowledgements: {} })
    if (url.pathname === "/global/sync/unassigned") return json([])
    if (url.pathname === "/api/target-binding") return json({ revision: "revision-local", bindings: {} })
    throw new Error(`unexpected request: ${request.method} ${url.pathname}`)
  }) as typeof globalThis.fetch

  let settings!: ReturnType<typeof useSyncSettings>
  let ready!: () => void
  const mounted = new Promise<void>((resolve) => {
    ready = resolve
  })

  function Probe() {
    settings = useSyncSettings()
    onMount(ready)
    return <box />
  }

  function Harness() {
    const renderer = useRenderer()
    const keymap = createDefaultOpenTuiKeymap(renderer)
    const config = createTuiResolvedConfig()
    const unregister = registerOpencodeKeymap(keymap, renderer, config)
    onCleanup(unregister)
    return (
      <TestTuiContexts directory={tmp.path} paths={{ home: tmp.path, state: stateDirectory, worktree: tmp.path }}>
        <ClipboardProvider value={{}}>
          <OpencodeKeymapProvider keymap={keymap}>
            <TuiConfigProvider config={config}>
              <KVProvider>
                <ThemeProvider mode="dark">
                  <ToastProvider>
                    <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
                      <DialogProvider>
                        <SyncSettingsProvider>
                          <Probe />
                        </SyncSettingsProvider>
                      </DialogProvider>
                    </SDKProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 72, height: 22, kittyKeyboard: true })
  const waitFrame = async (value: string) => {
    await wait(`${value} frame`, async () => {
      await app.renderOnce()
      return app.captureCharFrame().includes(value)
    })
  }
  try {
    await mounted
    await wait("local account", () => settings.model().account.state === "connected")
    calls.length = 0

    const started = performance.now()
    expect(await settings.open()).toBe("completed")
    expect(performance.now() - started).toBeLessThan(100)
    await waitFrame("Local space")

    expect(app.captureCharFrame()).toContain("not checked")
    expect(calls).toEqual([{ method: "GET", path: "/global/sync/state" }])
    expect(calls.some((call) => call.method !== "GET")).toBe(false)

    for (let index = 0; index < 4; index++) app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await wait("local enabled edit", () => calls.some((call) => call.path === "/global/sync/enabled"))
    await wait("local enabled model", () => settings.model().enabled === false)
    expect(calls.filter((call) => call.method !== "GET")).toEqual([{ method: "PATCH", path: "/global/sync/enabled" }])
    expect(calls.some((call) => call.path === "/global/sync/status" || call.path === "/global/sync/spaces")).toBe(false)

    const refreshing = settings.refresh(true)
    await wait("checking model", () => settings.model().remote === "checking")
    await waitFrame("checking")
    expect(app.captureCharFrame()).toContain("Local space")

    releaseStatus()
    await refreshing
    await wait("ready model", () => settings.model().remote === "ready")
    expect(settings.model().spaces).toHaveLength(7)
    await waitFrame("ready")
    expect(app.captureCharFrame()).toContain("Local space")

    statusUnavailable = true
    await settings.refresh(true)
    await wait("unavailable model", () => settings.model().remote === "unavailable")
    expect(settings.model().spaces).toHaveLength(7)
    await waitFrame("unavailable")
    expect(app.captureCharFrame()).toContain("Local space")

    statusUnavailable = false
    delayNextDiscovery = true
    const stale = settings.refresh(true)
    await wait("stale discovery", () => discoveryCalls === 2)
    const latest = settings.refresh(true)
    await latest
    await stale
    expect(settings.model().remote).toBe("ready")
    expect(settings.model().spaces).toHaveLength(7)
  } finally {
    app.renderer.destroy()
  }
})
