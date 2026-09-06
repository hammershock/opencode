import { describe, expect, test } from "bun:test"
import { applyShellCompletion, stringOffset } from "@/cli/cmd/run/footer.prompt"

describe("direct User Shell completion", () => {
  test("applies a server replacement range in the middle of input", () => {
    expect(
      applyShellCompletion("cat two\\ wor tail", {
        value: "two\\ words.txt",
        replacement: { start: 4, end: 12 },
      }),
    ).toEqual({ value: "cat two\\ words.txt tail", cursor: 18 })
  })

  test("converts a display-width cursor to a UTF-16 API offset", () => {
    expect(stringOffset("echo 目录/x", Bun.stringWidth("echo 目录"))).toBe("echo 目录".length)
  })
})
