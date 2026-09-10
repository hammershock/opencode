import { describe, expect, test } from "bun:test"
import {
  displayTruncate,
  inspectionFooterFrame,
  inspectionFrame,
  selectFooter,
  selectFooterWidth,
} from "../../src/ui/dialog-select"

describe("dialog selected-title inspection", () => {
  test("keeps every frame inside the row and reveals the complete identity over time", () => {
    const identity = "provider/模型-with-a-genuinely-unbounded-identifier"
    const frames = Array.from({ length: [...`${identity}   `].length }, (_, offset) =>
      inspectionFrame(identity, 16, offset),
    )

    expect(frames.every((frame) => Bun.stringWidth(frame) <= 16)).toBe(true)
    expect(frames.join(" ")).toContain("provider")
    expect(frames.join(" ")).toContain("identifier")
  })

  test("does not move a title that already fits", () => {
    expect(inspectionFrame("short-model", 20, 9)).toBe("short-model")
  })

  test("keeps an unfocused wide-character identity within its static budget", () => {
    const value = displayTruncate("模型模型/provider-name", 12)
    expect(Bun.stringWidth(value)).toBeLessThanOrEqual(12)
    expect(value).toEndWith("…")
  })

  test("keeps a flattened provider footer bounded and fully inspectable while focused", () => {
    const provider = "很长的中文Provider名称/with-an-unbounded-suffix"
    const stable = displayTruncate(provider, 18)
    const frames = Array.from({ length: [...`${provider}   `].length }, (_, offset) =>
      inspectionFrame(provider, 18, offset),
    )

    expect(Bun.stringWidth(stable)).toBeLessThanOrEqual(18)
    expect(frames.every((frame) => Bun.stringWidth(frame) <= 18)).toBe(true)
    expect(frames.join(" ")).toContain("中文")
    expect(frames.join(" ")).toContain("suffix")
  })

  test("cycles selected footer detail without moving its fixed status", () => {
    const detail = "a100-2gpu · /a/very/long/session/location"
    const frames = Array.from({ length: [...`${detail}   `].length }, (_, offset) =>
      inspectionFooterFrame(detail, "! partial", 24, offset, true),
    )

    expect(frames.every((frame) => frame.suffix === "! partial")).toBe(true)
    expect(frames.every((frame) => frame.separator)).toBe(true)
    expect(frames.every((frame) => Bun.stringWidth(frame.detail) + Bun.stringWidth(` · ${frame.suffix}`) <= 24)).toBe(
      true,
    )
    expect(frames.map((frame) => frame.detail).join(" ")).toContain("a100-2gpu")
    expect(frames.map((frame) => frame.detail).join(" ")).toContain("location")
  })

  test("keeps an unfocused footer static and bounded", () => {
    const frame = inspectionFooterFrame("local · /a/very/long/session/location", "● ready", 20, 12, false)
    expect(frame.suffix).toBe("● ready")
    expect(frame.separator).toBe(true)
    expect(frame.detail).toEndWith("…")
    expect(Bun.stringWidth(frame.detail) + Bun.stringWidth(` · ${frame.suffix}`)).toBeLessThanOrEqual(20)
  })

  test("switches the Free footer to the bounded provider category in search mode", () => {
    const option = {
      title: "model",
      value: "model",
      category: "Provider category",
      footer: "Free",
      footerWidth: 4,
      flatFooter: "很长的中文 Provider category",
      flatFooterWidth: 18,
    }

    expect(selectFooter(option, false)).toBe("Free")
    expect(selectFooterWidth(option, false)).toBe(4)
    const flattened = selectFooter(option, true)
    expect(flattened).toBe("很长的中文 Provider category")
    expect(selectFooterWidth(option, true)).toBe(18)
    if (typeof flattened !== "string") throw new Error("expected a textual model footer")
    expect(Bun.stringWidth(displayTruncate(flattened, selectFooterWidth(option, true)!))).toBeLessThanOrEqual(18)
  })
})
