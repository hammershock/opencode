/** @jsxImportSource @opentui/solid */
import { BoxRenderable, type Renderable } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { describe, expect, test } from "bun:test"
import { mkdir } from "node:fs/promises"
import path from "node:path"
import { SkillInvocationRow } from "../../src/component/skill-invocation"
import { TuiConfigProvider } from "../../src/config"
import { KVProvider } from "../../src/context/kv"
import { ThemeProvider } from "../../src/context/theme"
import { TestTuiContexts } from "../fixture/tui-environment"
import { createTuiResolvedConfig } from "../fixture/tui-runtime"
import { tmpdir } from "../fixture/fixture"

const snapshot = {
  id: "ski_test",
  name: "review-changes",
  digest: "a".repeat(64),
  source: { kind: "opencode-global" as const, label: "OpenCode" },
  content: "Exact durable Skill instructions",
  status: "loaded" as const,
}

describe("SkillInvocationRow", () => {
  test("starts collapsed and expands the durable snapshot from the keyboard", async () => {
    await using tmp = await tmpdir()
    const app = await render(80, tmp.path)
    try {
      await settle(app)
      expect(app.captureCharFrame()).toContain("● Skill · review-changes · OpenCode · loaded · Enter to expand")
      expect(app.captureCharFrame()).not.toContain(snapshot.content)

      const row = focusable(app.renderer.root)
      expect(row).toBeDefined()
      row!.focus()
      app.mockInput.pressEnter()
      await settle(app)

      expect(app.captureCharFrame()).toContain("· collapse")
      expect(app.captureCharFrame()).toContain(snapshot.content)
    } finally {
      app.renderer.destroy()
    }
  })

  test("keeps the loaded state readable in a narrow terminal", async () => {
    await using tmp = await tmpdir()
    const app = await render(36, tmp.path)
    try {
      await settle(app)
      const frame = app.captureCharFrame()
      expect(frame).toContain("● Skill · revi")
      expect(frame).toContain("· loaded")
      expect(frame).not.toContain("OpenCode")
      expect(frame).not.toContain(snapshot.content)
    } finally {
      app.renderer.destroy()
    }
  })
})

async function render(width: number, directory: string) {
  const state = path.join(directory, "state")
  await mkdir(state, { recursive: true })
  await Bun.write(path.join(state, "kv.json"), "{}")
  return testRender(
    () => (
      <TestTuiContexts directory={directory} paths={{ home: directory, state, worktree: directory }}>
        <TuiConfigProvider config={createTuiResolvedConfig()}>
          <KVProvider>
            <ThemeProvider mode="dark">
              <SkillInvocationRow snapshot={snapshot} width={width} />
            </ThemeProvider>
          </KVProvider>
        </TuiConfigProvider>
      </TestTuiContexts>
    ),
    { width, height: 12, kittyKeyboard: true, useThread: false },
  )
}

async function settle(app: Awaited<ReturnType<typeof testRender>>) {
  await app.renderOnce()
  await Bun.sleep(25)
  await app.renderOnce()
}

function focusable(root: Renderable): BoxRenderable | undefined {
  if (root instanceof BoxRenderable && root.focusable) return root
  return root.getChildren().map(focusable).find(Boolean)
}
