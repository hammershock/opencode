import { describe, expect, test } from "bun:test"
import { autocompleteSelectionInWindow } from "../../src/component/prompt/autocomplete"

describe("autocompleteSelectionInWindow", () => {
  test("moves an offscreen selection to the nearest visible row after wheel scrolling", () => {
    expect(autocompleteSelectionInWindow(0, { count: 10, limit: 8, offset: 1 })).toBe(1)
    expect(autocompleteSelectionInWindow(9, { count: 10, limit: 8, offset: 0 })).toBe(7)
  })

  test("preserves a selection that remains visible", () => {
    expect(autocompleteSelectionInWindow(5, { count: 10, limit: 8, offset: 2 })).toBe(5)
  })
})
