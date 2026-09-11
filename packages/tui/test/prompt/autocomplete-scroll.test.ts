import { describe, expect, test } from "bun:test"
import { autocompleteScrollOffset, autocompleteSelectionInWindow } from "../../src/component/prompt/autocomplete"

describe("autocompleteScrollOffset", () => {
  test("keeps a visible selection stationary", () => {
    expect(autocompleteScrollOffset(2, { count: 10, limit: 8, selected: 4 })).toBe(2)
  })

  test("reveals keyboard navigation with absolute monotonic offsets", () => {
    const offsets = [7, 8, 9].reduce<number[]>((result, selected) => {
      result.push(
        autocompleteScrollOffset(result.at(-1) ?? 0, {
          count: 10,
          limit: 8,
          selected,
        }),
      )
      return result
    }, [])

    expect(offsets).toEqual([0, 1, 2])
  })

  test("clamps stale viewport state after filtering shrinks the options", () => {
    expect(autocompleteScrollOffset(8, { count: 3, limit: 3, selected: 0 })).toBe(0)
  })

  test("reveals a wrapped selection from the top or bottom", () => {
    expect(autocompleteScrollOffset(2, { count: 10, limit: 8, selected: 0 })).toBe(0)
    expect(autocompleteScrollOffset(0, { count: 10, limit: 8, selected: 9 })).toBe(2)
  })
})

describe("autocompleteSelectionInWindow", () => {
  test("moves an offscreen selection to the nearest visible row after wheel scrolling", () => {
    expect(autocompleteSelectionInWindow(0, { count: 10, limit: 8, offset: 1 })).toBe(1)
    expect(autocompleteSelectionInWindow(9, { count: 10, limit: 8, offset: 0 })).toBe(7)
  })

  test("preserves a selection that remains visible", () => {
    expect(autocompleteSelectionInWindow(5, { count: 10, limit: 8, offset: 2 })).toBe(5)
  })
})
