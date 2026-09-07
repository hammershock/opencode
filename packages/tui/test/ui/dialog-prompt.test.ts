import { describe, expect, test } from "bun:test"
import { promptCandidateWindow } from "../../src/ui/dialog-prompt"
import { shellStringOffset } from "../../src/component/prompt/autocomplete"

describe("prompt completion candidates", () => {
  test("keeps short candidate lists one item per line", () => {
    expect(promptCandidateWindow(["/home/a/", "/home/b/"], 0)).toEqual({
      start: 0,
      items: ["/home/a/", "/home/b/"],
    })
  })

  test("keeps an eight-row window around the selected candidate", () => {
    const candidates = Array.from({ length: 20 }, (_, index) => `/home/project-${index}/`)
    const visible = promptCandidateWindow(candidates, 11)

    expect(visible.start).toBe(4)
    expect(visible.items).toEqual(candidates.slice(4, 12))
  })

  test("converts the visual shell cursor before requesting completion", () => {
    expect(shellStringOffset("echo 目录/x", Bun.stringWidth("echo 目录"))).toBe("echo 目录".length)
  })
})
