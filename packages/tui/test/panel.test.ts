import { expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createPanelState } from "../src/context/panel"

test("presentation changes preserve the selected panel identity", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.setWidth(160)
    panels.open({ plugin: "review", name: "diff", sessionID: "session" })
    const current = panels.current()
    expect(panels.presentation()).toBe("panel")
    panels.toggleFullscreen()
    expect(panels.presentation()).toBe("fullscreen")
    expect(panels.current()).toBe(current)
    panels.toggleFullscreen()
    expect(panels.presentation()).toBe("panel")
    expect(panels.current()).toBe(current)
    panels.open({ plugin: "review", name: "diff", sessionID: "session" })
    expect(panels.current()).toBe(current)
    dispose()
  })
})

test("narrow geometry overrides presentation without discarding the user's choice", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.open({ plugin: "review", name: "diff", sessionID: "session" })
    panels.setWidth(80)
    expect(panels.canSplit()).toBe(false)
    expect(panels.presentation()).toBe("fullscreen")
    panels.toggleFullscreen()
    panels.setWidth(81)
    expect(panels.canSplit()).toBe(true)
    expect(panels.presentation()).toBe("panel")
    panels.toggleFullscreen()
    panels.setWidth(60)
    panels.setWidth(160)
    expect(panels.presentation()).toBe("fullscreen")
    dispose()
  })
})

test("releasing a plugin contribution only closes its own selected panel", () => {
  createRoot((dispose) => {
    const panels = createPanelState()
    panels.open({ plugin: "review", name: "diff", sessionID: "session" })
    const current = panels.current()
    panels.release("other")
    panels.release("review", "another-panel")
    expect(panels.current()).toBe(current)
    panels.release("review", "diff")
    expect(panels.current()).toBeUndefined()
    dispose()
  })
})
