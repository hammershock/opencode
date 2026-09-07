import { describe, expect, test } from "bun:test"
import { createShellCompletionGeneration, invalidateShellCompletion } from "../../src/component/prompt/autocomplete"

describe("Shell autocomplete generation", () => {
  test("rejects a delayed result after input or cursor mutation", () => {
    const generation = createShellCompletionGeneration()
    const request = generation.begin()

    invalidateShellCompletion(generation, false, () => undefined)

    expect(generation.accepts(request)).toBe(false)
  })

  test("invalidates an already visible list before a stale candidate can apply", () => {
    const generation = createShellCompletionGeneration()
    const request = generation.begin()
    expect(generation.accepts(request)).toBe(true)
    let hidden = false

    invalidateShellCompletion(generation, "shell", () => {
      hidden = true
    })

    expect(hidden).toBe(true)
    expect(generation.accepts(request)).toBe(false)
  })
})
