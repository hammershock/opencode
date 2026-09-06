import { describe, expect, test } from "bun:test"
import { compactPromptCandidates } from "../../src/ui/dialog-prompt"

describe("prompt completion candidates", () => {
  test("keeps short candidate lists one item per line", () => {
    expect(compactPromptCandidates(["/home/a/", "/home/b/"])).toEqual(["/home/a/", "/home/b/"])
  })

  test("collapses candidate lists that would fill the prompt", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => `/home/project-${index}/`)
    const visible = compactPromptCandidates(candidates)

    expect(visible).toHaveLength(12)
    expect(visible.slice(0, 11)).toEqual(candidates.slice(0, 11))
    expect(visible[11]).toBe("… 9 more matches")
  })
})
