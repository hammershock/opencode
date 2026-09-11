import { expect, mock, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { TextareaRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { Effect } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { Global } from "@opencode-ai/core/global"
import { createTuiResolvedConfig } from "./fixture/tui-runtime"
import { createEventSource, createFetch, directory, json } from "./fixture/tui-sdk"

async function waitForFrame(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    if (setup.captureCharFrame().includes(text)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${text}\n${setup.captureCharFrame()}`)
}

async function waitForEditor(setup: Awaited<ReturnType<typeof createTestRenderer>>, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    const editor = setup.renderer.currentFocusedEditor
    if (editor instanceof TextareaRenderable) return editor
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for a focused textarea\n${setup.captureCharFrame()}`)
}

async function waitForEditorText(setup: Awaited<ReturnType<typeof createTestRenderer>>, text: string, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    await setup.renderOnce()
    const editor = setup.renderer.currentFocusedEditor
    if (editor instanceof TextareaRenderable && editor.plainText === text) return editor
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for editor text ${JSON.stringify(text)}`)
}

async function waitForSessionRequests(requests: URL[], count: number, timeout = 2_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (requests.length >= count) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${count} Session list requests; observed ${requests.length}`)
}

test("SIGHUP clears title and disposes scoped resources once", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const titles: string[] = []
  const setTitle = setup.renderer.setTerminalTitle.bind(setup.renderer)
  setup.renderer.setTerminalTitle = (title) => {
    titles.push(title)
    setTitle(title)
  }
  const listeners = new Set(process.listeners("SIGHUP"))
  const events = createEventSource()
  const calls = createFetch()
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposes = 0

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
          async dispose() {
            disposes++
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )
    await ready
    process.emit("SIGHUP")
    await task

    expect(setup.renderer.isDestroyed).toBe(true)
    expect(titles.at(-1)).toBe("")
    expect(disposes).toBe(1)
    expect(process.listeners("SIGHUP").every((listener) => listeners.has(listener))).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("app.exit prints the session epilogue after scoped cleanup", async () => {
  const setup = await createTestRenderer({ width: 80, height: 24, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "Demo session",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
  })
  const originalWrite = process.stdout.write.bind(process.stdout)
  let stdout = ""
  let api: TuiPluginApi | undefined
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })

  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += String(chunk)
    return true
  }) as typeof process.stdout.write

  try {
    const { run } = await import("../src/app")
    const task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.renderOnce()
    await setup.renderOnce()
    api?.keymap.dispatchCommand("app.exit")
    await task

    expect(stdout).toContain("Demo session")
    expect(stdout).toContain("opencode -s dummy")
  } finally {
    process.stdout.write = originalWrite
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test.each([
  { route: "QuickStart", args: {} },
  { route: "Session", args: { continue: true } },
] as const)("Ctrl+P opens the command palette from the production $route route", async ({ args }) => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
    if (url.pathname === "/session/dummy")
      return json({
        id: "dummy",
        title: "PromptRef integration",
        slug: "dummy",
        projectID: "project",
        directory,
        version: "0.0.0-test",
        time: { created: 0, updated: 0 },
      })
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session")
      return json([
        {
          id: "dummy",
          title: "PromptRef integration",
          slug: "dummy",
          projectID: "project",
          directory,
          version: "0.0.0-test",
          time: { created: 0, updated: 0 },
        },
      ])
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
        args,
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
    setup.mockInput.pressKey("p", { ctrl: true })
    await setup.waitForVisualIdle()

    expect(setup.captureCharFrame()).toContain("Commands")
    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("Ctrl+P opens the production Skill Manager without a model turn", async () => {
  const setup = await createTestRenderer({ width: 100, height: 44, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const catalogRequests: URL[] = []
  let scopeUpdates = 0
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({
        path: "/tmp/opencode/targets.jsonc",
        revision: "target",
        targets: [],
        diagnostics: [],
        valid: true,
      })
    if (url.pathname.startsWith("/api/skill/settings/") && url.pathname.endsWith("/target-scope")) {
      scopeUpdates++
      return json({
        path: "/tmp/opencode/opencode.jsonc",
        revision: `settings-${scopeUpdates}`,
        roots: [
          {
            kind: "opencode-global",
            value: "/tmp/opencode/skills",
            resolved: "/tmp/opencode/skills",
            default: true,
            status: "ready",
          },
        ],
        targets: {},
        diagnostics: [],
        valid: true,
      })
    }
    if (url.pathname === "/api/skill/settings")
      return json({
        path: "/tmp/opencode/opencode.jsonc",
        revision: "settings",
        roots: [
          {
            kind: "opencode-global",
            value: "/tmp/opencode/skills",
            resolved: "/tmp/opencode/skills",
            default: true,
            status: "ready",
          },
        ],
        targets: {},
        diagnostics: [],
        valid: true,
      })
    if (url.pathname === "/api/skill/catalog") {
      catalogRequests.push(url)
      return json({
        location: { target: { type: "local" }, directory: "/tmp/opencode", project: { id: "test", directory } },
        data: {
          revision: "catalog",
          digest: "catalog",
          skills: [
            {
              id: `skl_${"1".repeat(64)}`,
              name: "review",
              description: "Review changes",
              sourceLabel: "OpenCode config",
              digest: "digest",
            },
          ],
          diagnostics: [],
        },
      })
    }
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
  })
  let started!: () => void
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
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
    await waitForEditor(setup, 5_000)
    expect(
      api?.keymap
        .getCommandEntries({ visibility: "reachable", namespace: "palette" })
        .map((entry) => entry.command.name),
    ).toContain("fork.skill.manage")
    const { getActiveCommandHost } = await import("../src/command-toolkit/host")
    expect(
      getActiveCommandHost(api!.keymap)
        ?.commands()
        .map((command) => command.identity),
    ).toContain("fork.skill.manage")
    const sessionRequests = calls.session.length
    setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame(setup, "Commands")
    await waitForEditor(setup)
    "Manage skills".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "Manage local discovery paths")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Discovery paths")

    const frame = setup.captureCharFrame()
    expect(frame).toContain("/tmp/opencode/skills")
    expect(frame).toContain("Source")
    expect(frame).toContain("Targets")
    expect(frame).toContain("State")
    expect(frame).toContain("● active")
    expect(frame).toContain("1 paths · 1 Skills")
    expect(catalogRequests.at(-1)?.searchParams.get("includeInactive")).toBe("true")
    expect(calls.session).toHaveLength(sessionRequests)

    await waitForEditor(setup)
    await setup.mockInput.typeText("review")
    await waitForFrame(setup, "review")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Target access · review")
    const targetFrame = setup.captureCharFrame()
    expect(targetFrame).toContain("[ Confirm ] enter · space toggle")
    expect(targetFrame).not.toContain("Save target access")
    expect(targetFrame).not.toContain("Actions")
    setup.mockInput.pressArrow("down")
    setup.mockInput.pressKey(" ")
    await waitForFrame(setup, "[ ] local")
    expect(scopeUpdates).toBe(0)
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Target access saved")
    expect(scopeUpdates).toBe(1)

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("QuickStart accepts and renders keyboard input without starving the keymap", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/config/providers")
      return json({
        providers: [{ id: "test", name: "Test", source: "custom", env: [], options: {}, models: {} }],
        default: {},
      })
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  const keymapErrors: string[] = []
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
  let disposeErrors = () => {}

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
          async start(input) {
            api = input.api
            disposeSlots = input.runtime.setupSlots(input.api).dispose
            disposeErrors = input.api.keymap.on("error", (event) => keymapErrors.push(event.code))
            started()
          },
          async dispose() {
            disposeErrors()
            disposeSlots()
          },
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    const editor = await waitForEditor(setup)

    const input = "QuickStart remains responsive"
    input.split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, input, 2_000)

    expect(editor.plainText).toBe(input)

    api?.keymap.dispatchCommand("prompt.clear")
    await waitForFrame(setup, "Ask anything", 2_000)
    expect(editor.plainText).toBe("")
    const unknown = "/definitely-unknown"
    unknown.split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, unknown, 2_000)
    const sessionRequests = calls.session.length
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Slash command does not exist", 2_000)
    expect(editor.plainText).toBe(unknown)
    expect(calls.session.length).toBe(sessionRequests)

    setup.mockInput.pressKey("p", { ctrl: true })
    await waitForFrame(setup, "Commands", 2_000)

    expect(keymapErrors).not.toContain("state-change-feedback-loop")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("session.undo restores a canonical Skill prompt and session.redo clears its V2 revert", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const legacySession = {
    id: "dummy",
    title: "Skill undo",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 10 },
  }
  const canonicalSession = {
    id: "dummy",
    projectID: "project",
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 0, updated: 10 },
    title: "Skill undo",
    location: { directory },
  }
  const message = {
    id: "msg_skill",
    type: "user",
    text: "$review inspect this",
    time: { created: 10 },
    skills: [
      {
        source: { start: 0, end: 7, text: "$review" },
        snapshot: {
          id: "ski_snapshot",
          name: "review",
          digest: "a".repeat(64),
          source: { kind: "opencode-global", label: "OpenCode" },
          content: "private instructions",
          status: "loaded",
        },
      },
    ],
  }
  const paths: string[] = []
  const calls = createFetch((url) => {
    paths.push(url.pathname)
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") return json(legacySession)
    if (url.pathname === "/session/dummy/message") return json([])
    if (url.pathname === "/api/session/dummy") return json({ data: canonicalSession })
    if (url.pathname === "/api/session/dummy/message") return json({ data: [message], cursor: {} })
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/api/session/dummy/activate") return json({ data: { status: "unchanged", diagnostics: [] } })
    if (url.pathname === "/api/skill/catalog")
      return json({
        location: { directory, project: { id: "project", directory } },
        data: {
          revision: "catalog",
          digest: "catalog",
          skills: [
            {
              id: "skl_review",
              name: "review",
              description: "Review changes",
              sourceLabel: "OpenCode · deadbeef",
              digest: "a".repeat(64),
            },
          ],
          diagnostics: [],
        },
      })
    if (url.pathname === "/api/session/dummy/interrupt") return new Response(null, { status: 204 })
    if (url.pathname === "/api/session/dummy/revert/stage") return json({ data: { messageID: message.id } })
    if (url.pathname === "/api/session/dummy/revert/clear") return new Response(null, { status: 204 })
    if (url.pathname === "/session") return json([legacySession])
  })
  let api: TuiPluginApi | undefined
  let disposeSlots = () => {}
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
        args: { continue: true },
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
    await waitForFrame(setup, message.text, 5_000)
    await waitForEditor(setup)
    api?.keymap.dispatchCommand("session.undo")
    const editor = await waitForEditorText(setup, message.text).catch((error) => {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nRequests: ${paths.join(", ")}`)
    })

    expect(editor.plainText).toBe(message.text)
    expect(paths).toContain("/api/session/dummy/interrupt")
    expect(paths).toContain("/api/session/dummy/revert/stage")
    expect(paths).not.toContain("/session/dummy/revert")

    events.emit({
      directory,
      project: "project",
      payload: {
        id: "evt_revert",
        type: "session.next.revert.staged",
        properties: { timestamp: 20, sessionID: "dummy", revert: { messageID: message.id } },
      },
    })
    await setup.renderOnce()
    api?.keymap.dispatchCommand("session.redo")
    const cleared = await waitForEditorText(setup, "")

    expect(cleared.plainText).toBe("")
    expect(paths).toContain("/api/session/dummy/revert/clear")
    expect(paths).not.toContain("/session/dummy/unrevert")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
}, 10_000)

test("a read-only Session keeps its draft while blocking Agent submission and allowing exit", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Read-only prompt",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    target: { type: "rexd", targetID: "missing-target" },
    time: { created: 0, updated: 0 },
  }
  const paths: string[] = []
  const calls = createFetch((url) => {
    paths.push(url.pathname)
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({
        status: "missing_local_target",
        missingTargetID: "missing-target",
        lastKnownTargetName: "offline",
        referencedSessionIDs: ["dummy"],
        location: { directory, target: session.target },
      })
    if (url.pathname === "/session") return json([session])
  })
  let started!: () => void
  const ready = new Promise<void>((resolve) => {
    started = resolve
  })
  let disposeSlots = () => {}
  let task: Promise<unknown> | undefined

  try {
    const { run } = await import("../src/app")
    task = Effect.runPromise(
      run({
        url: "http://test",
        directory,
        config: createTuiResolvedConfig({ plugin_enabled: {} }),
        fetch: calls.fetch,
        events: events.source,
        args: { continue: true },
        pluginHost: {
          async start(input) {
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
    await waitForFrame(setup, "Open read-only")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Draft editing is")
    const editor = await waitForEditor(setup)

    const draft = "keep this draft"
    editor.setText(draft)
    editor.focus()
    await waitForFrame(setup, draft)
    const promptRequests = paths.filter((item) => item.includes("/session/dummy/message")).length
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Current Session is read-only")

    expect(editor.plainText).toBe(draft)
    expect(paths.filter((item) => item.includes("/session/dummy/message"))).toHaveLength(promptRequests)

    editor.setText("@file")
    await setup.renderOnce()
    await Bun.sleep(20)
    expect(paths.some((item) => item.includes("/api/fs"))).toBe(false)

    editor.setText("")
    editor.focus()
    setup.mockInput.pressKey("/")
    "permissions".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "/permissions")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Current Session is read-only")
    expect(editor.plainText).toBe("/permissions")

    editor.setText("")
    editor.focus()
    setup.mockInput.pressKey("/")
    "new".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "/new")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Current Session is read-only")
    expect(editor.plainText).toBe("/new")

    editor.setText("")
    editor.focus()
    setup.mockInput.pressKey("/")
    await waitForFrame(setup, "/context")
    expect(setup.captureCharFrame()).not.toContain("/agents")
    "quit".split("").forEach((key) => setup.mockInput.pressKey(key))
    await waitForFrame(setup, "/quit")
    setup.mockInput.pressEnter()
    await task
    expect(setup.renderer.isDestroyed).toBe(true)
  } finally {
    if (!setup.renderer.isDestroyed) {
      process.emit("SIGHUP")
      await task
    }
    mock.restore()
  }
}, 10_000)

test("an open session waits for confirmation before returning home after deletion", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Deleted elsewhere",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session") return json([session])
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
        args: { continue: true },
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
      project: "proj_test",
      payload: { id: "evt_deleted", type: "session.deleted", properties: { sessionID: session.id, info: session } },
    })
    await setup.waitForVisualIdle()

    expect(setup.captureCharFrame()).toContain("Session deleted")
    expect(setup.captureCharFrame()).toContain("This session is no longer available.")

    setup.mockInput.pressEnter()
    await setup.waitForVisualIdle()
    expect(setup.captureCharFrame()).not.toContain("Session deleted")
    expect(setup.captureCharFrame()).toContain("Sync")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("an open session detects a remotely projected deletion outside its routed Location", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const session = {
    id: "dummy",
    title: "Deleted on another device",
    slug: "dummy",
    projectID: "project",
    directory,
    version: "0.0.0-test",
    time: { created: 0, updated: 0 },
  }
  let present = true
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session/dummy") return json(session)
    if (url.pathname === "/api/session/dummy/target-resolution")
      return json({ status: "resolved", location: { directory } })
    if (url.pathname === "/session") return json(present ? [session] : [])
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
        args: { continue: true },
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
    present = false
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection", type: "sync.projection.updated", properties: { revision: 1 } },
    })
    await waitForFrame(setup, "Session deleted")

    expect(setup.captureCharFrame()).toContain("This session is no longer available.")
    setup.mockInput.pressEnter()
    await waitForFrame(setup, "Sync")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})

test("an open Sessions dialog refreshes when another device projects a Session", async () => {
  const setup = await createTestRenderer({ width: 100, height: 30, useThread: false })
  const core = await import("@opentui/core")
  mock.module("@opentui/core", () => ({ ...core, createCliRenderer: async () => setup.renderer }))
  const events = createEventSource()
  const first = {
    id: "first",
    title: "Existing session",
    slug: "first",
    projectID: "proj_test",
    directory,
    version: "0.0.0-test",
    time: { created: 1, updated: 1 },
  }
  const second = {
    ...first,
    id: "second",
    slug: "second",
    title: "Created on mywindows",
    time: { created: 2, updated: 2 },
  }
  let sessions = [first]
  const calls = createFetch((url) => {
    if (url.pathname === "/api/target")
      return json({ path: "/tmp/opencode/targets.jsonc", revision: "test", targets: [], diagnostics: [], valid: true })
    if (url.pathname === "/session") return json(sessions)
    if (url.pathname === "/global/sync/status") return json({ configured: true, deviceID: "mac" })
    if (url.pathname === "/global/sync/sessions") return json([])
  })
  let api: TuiPluginApi | undefined
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
          async start(input) {
            api = input.api
            started()
          },
          async dispose() {},
        },
      }).pipe(Effect.provide(AppNodeBuilder.build(Global.node))),
    )

    await ready
    await setup.waitForVisualIdle()
    api?.keymap.dispatchCommand("session.list")
    await waitForFrame(setup, "Sessions")
    await setup.waitForVisualIdle()
    const initialRequests = calls.session.length
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection_initial", type: "sync.projection.updated", properties: { revision: 1 } },
    })
    await waitForSessionRequests(calls.session, initialRequests + 1)
    await waitForFrame(setup, "Existing session")
    sessions = [first, second]
    const secondRequests = calls.session.length
    events.emit({
      directory: "/home/remote",
      project: "proj_test",
      payload: { id: "evt_projection_second", type: "sync.projection.updated", properties: { revision: 2 } },
    })
    await waitForSessionRequests(calls.session, secondRequests + 1)
    await waitForFrame(setup, "Created on mywindows")

    process.emit("SIGHUP")
    await task
  } finally {
    if (!setup.renderer.isDestroyed) setup.renderer.destroy()
    mock.restore()
  }
})
