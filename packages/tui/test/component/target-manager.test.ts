import { describe, expect, test } from "bun:test"
import { targetHealthLabel } from "../../src/component/target-manager"

describe("target health presentation", () => {
  test("reserves the healthy symbol for ready targets", () => {
    expect(targetHealthLabel("checking")).toBe("◐ checking")
    expect(targetHealthLabel("ready")).toBe("● ready")
    expect(targetHealthLabel("unavailable")).toBe("! unavailable")
    expect(targetHealthLabel("invalid")).toBe("! invalid")
  })
})
