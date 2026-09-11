import { describe, expect, test } from "bun:test"
import { Skill } from "@opencode-ai/schema/skill"
import { Command } from "../src/command"

const skill = (id: string, sourceLabel = "Imported") =>
  Skill.Metadata.make({
    id: Skill.ID.make(`skl_${id.repeat(64)}`),
    name: "review",
    description: "Review a patch",
    sourceLabel,
    digest: Skill.Digest.make(id.repeat(64)),
  })

describe("Skill command compatibility projection", () => {
  test("keeps existing command precedence and never exposes a Skill body template", () => {
    const command: Command.Info = {
      name: "review",
      description: "Built-in review",
      source: "command",
      provenance: { type: "builtin" },
      template: "Command $ARGUMENTS",
      hints: ["$ARGUMENTS"],
    }
    expect(Command.withSkillCompatibility([command], [skill("1")])).toEqual([command])

    const projected = Command.withSkillCompatibility([], [skill("1")])
    expect(projected).toMatchObject([
      {
        name: "review",
        source: "skill",
        provenance: { type: "skill", location: "Imported" },
        template: "",
        hints: [],
      },
    ])
    expect(JSON.stringify(projected)).not.toContain("SKILL.md")
  })

  test("marks duplicate canonical names ambiguous instead of choosing source order", () => {
    const projected = Command.withSkillCompatibility([], [skill("2", "Z source"), skill("1", "A source")])
    expect(projected).toMatchObject([
      {
        name: "review",
        description: "Ambiguous Skill name (2 sources; use $ mention to choose)",
        provenance: { type: "skill", location: "A source, Z source" },
      },
    ])
  })
})
