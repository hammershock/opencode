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
import { RemoteStatusProvider } from "../../../src/context/remote-status"
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
    activeSpaceID: "account-v1",
    enabled: true,
    intervalSeconds: 30,
    spaces: [
      {
        accountID: "account-local",
        descriptor: {
          namespaceID: "account-v1",
          name: "Baidu Netdisk",
          protocol: { major: 1, minor: 0 },
          encryption: "none",
          createdAt: 1,
          updatedAt: 2,
          summary: { sessions: 3, devices: 2, updatedAt: 2 },
          revision: 0,
        },
        remoteRoot: "/apps/opencode-sync/session-sync",
        joinedAt: 1,
      },
    ],
  }
  const calls: Array<{ method: string; path: string }> = []
  let releaseStatus!: () => void
  let cloudUnavailable = false
  let cloudCalls = 0
  let delayNextCloud = false
  let releaseSync!: () => void
  const syncGate = new Promise<void>((resolve) => {
    releaseSync = resolve
  })
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
    if (url.pathname === "/global/sync/now") {
      await syncGate
      return json(null)
    }
    if (url.pathname === "/global/sync/cloud") {
      cloudCalls++
      if (delayNextCloud) {
        delayNextCloud = false
        await new Promise<void>((resolve) => request.signal.addEventListener("abort", () => resolve(), { once: true }))
        return new Response(null, { status: 503 })
      }
      await statusGate
      if (cloudUnavailable) return new Response(null, { status: 503 })
      return json({ status: "ready", manifest: { version: 1, protocol: { major: 1, minor: 0 }, createdAt: 1 } })
    }
    if (url.pathname === "/global/sync/status") {
      return json({
        configured: true,
        initialized: true,
        authenticated: true,
        enabled: true,
        locked: false,
        provider: "baidu",
        namespaceID: "account-v1",
        deviceID: "device-local",
        account: state.account,
        activeSpace: { namespaceID: "account-v1", name: "Baidu Netdisk", encryption: "none" },
        intervalSeconds: 30,
        outbox: 0,
        cursors: {},
      })
    }
    if (url.pathname === "/global/sync/sessions") return json([])
    if (url.pathname === "/global/sync/devices")
      return json({ namespaceID: "account-v1", devices: [], acknowledgements: {} })
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
                    <RemoteStatusProvider>
                      <SDKProvider url="http://test" fetch={fetch} events={eventSource()}>
                        <DialogProvider>
                          <SyncSettingsProvider>
                            <Probe />
                          </SyncSettingsProvider>
                        </DialogProvider>
                      </SDKProvider>
                    </RemoteStatusProvider>
                  </ToastProvider>
                </ThemeProvider>
              </KVProvider>
            </TuiConfigProvider>
          </OpencodeKeymapProvider>
        </ClipboardProvider>
      </TestTuiContexts>
    )
  }

  const app = await testRender(() => <Harness />, { width: 72, height: 30, kittyKeyboard: true })
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
    await waitFrame("lo***@example.com")

    expect(app.captureCharFrame()).toContain("not checked")
    expect(calls).toEqual([{ method: "GET", path: "/global/sync/state" }])
    expect(calls.some((call) => call.method !== "GET")).toBe(false)

    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await wait("local enabled edit", () => calls.some((call) => call.path === "/global/sync/enabled"))
    await wait("local enabled model", () => settings.model().enabled === false)
    expect(calls.filter((call) => call.method !== "GET")).toEqual([{ method: "PATCH", path: "/global/sync/enabled" }])
    expect(calls.some((call) => call.path === "/global/sync/status" || call.path === "/global/sync/cloud")).toBe(false)

    const refreshing = settings.refresh(true)
    await wait("checking model", () => settings.model().cloud === "checking")
    await waitFrame("checking")
    expect(app.captureCharFrame()).toContain("lo***@example.com")

    releaseStatus()
    await refreshing
    await wait("ready model", () => settings.model().cloud === "ready")
    await waitFrame("ready")
    expect(app.captureCharFrame()).toContain("lo***@example.com")

    const sessionCatalogCalls = calls.filter((call) => call.path === "/global/sync/sessions").length
    app.mockInput.pressArrow("down")
    app.mockInput.pressEnter()
    await wait("sync request", () => calls.some((call) => call.path === "/global/sync/now"))
    app.mockInput.pressEscape()
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Sync settings")
    releaseSync()
    await wait("sync refresh", () => settings.model().state === "off")
    expect(cloudCalls).toBe(2)
    expect(calls.filter((call) => call.path === "/global/sync/sessions")).toHaveLength(sessionCatalogCalls)
    await app.renderOnce()
    expect(app.captureCharFrame()).not.toContain("Sync settings")
    await settings.open()
    await waitFrame("Sync settings")

    cloudUnavailable = true
    await settings.refresh(true)
    await wait("unavailable model", () => settings.model().cloud === "unavailable")
    await waitFrame("unavailable")
    expect(app.captureCharFrame()).toContain("lo***@example.com")

    cloudUnavailable = false
    delayNextCloud = true
    const cloudCallsBeforeStale = cloudCalls
    const stale = settings.refresh(true)
    await wait("stale cloud request", () => cloudCalls > cloudCallsBeforeStale)
    const latest = settings.refresh(true)
    await latest
    await stale
    expect(settings.model().cloud).toBe("ready")
  } finally {
    app.renderer.destroy()
  }
})
