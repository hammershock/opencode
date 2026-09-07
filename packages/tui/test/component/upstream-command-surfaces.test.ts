import { describe, expect, test } from "bun:test"
import { slashCommandPalettePresentation } from "../../src/component/command-palette"
import { slashAutocompleteOptions } from "../../src/component/prompt/autocomplete"

describe("upstream command surfaces", () => {
  const command = {
    identity: "session.list",
    display: "/sessions",
    title: "Switch session",
    description: "Search and open a session · upstream",
    category: "Session",
    provenance: { type: "upstream" as const, host: "tui", identity: "session.list" },
    shadowed: [],
  }

  test("slash autocomplete renders the reviewed purpose", () => {
    expect(slashAutocompleteOptions([command])[0]).toMatchObject({
      display: "/sessions  ",
      description: "Search and open a session · upstream",
    })
  })

  test("Ctrl+P renders the same reviewed purpose", () => {
    expect(slashCommandPalettePresentation(command)).toEqual({
      title: "Switch session",
      description: "Search and open a session · upstream",
      category: "Session",
    })
  })
})
