import { describe, expect, test } from "bun:test"
import { Prompt } from "@opencode-ai/schema/prompt"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { SkillSlashCompatibility } from "../../src/skill/slash-compatibility"

const metadata = (id: string, sourceLabel = "Imported") =>
  Skill.Metadata.make({
    id: Skill.ID.make(`skl_${id.repeat(64)}`),
    name: "review",
    description: "Review a patch",
    sourceLabel,
    digest: Skill.Digest.make(id.repeat(64)),
  })

describe("Skill slash compatibility", () => {
  test("converts one canonical name without parsing command placeholders", () => {
    const resolved = SkillSlashCompatibility.resolve({ name: "review", arguments: "keep $ARGUMENTS and $1 literal" }, [
      metadata("1"),
    ])
    expect(resolved).not.toBeInstanceOf(SkillSlashCompatibility.Error)
    if (resolved instanceof SkillSlashCompatibility.Error) return
    expect(resolved).toEqual({
      text: "$review keep $ARGUMENTS and $1 literal",
      skills: [
        {
          id: Skill.ID.make(`skl_${"1".repeat(64)}`),
          name: "review",
          source: { start: 0, end: 7, text: "$review" },
        },
      ],
    })
  })

  test("rejects ambiguous names with deterministic candidates", () => {
    const resolved = SkillSlashCompatibility.resolve({ name: "review", arguments: "patch" }, [
      metadata("2", "Z source"),
      metadata("1", "A source"),
    ])
    expect(resolved).toBeInstanceOf(SkillSlashCompatibility.Error)
    if (!(resolved instanceof SkillSlashCompatibility.Error)) return
    expect(resolved.kind).toBe("ambiguous")
    expect(resolved.candidates.map((candidate) => candidate.sourceLabel)).toEqual(["A source", "Z source"])
  })

  test("reconciles exact retries from the portable invocation snapshot", () => {
    const expected = Prompt.make({ text: "$review patch" })
    const recorded = Prompt.make({
      text: expected.text,
      invocations: [
        {
          source: { start: 0, end: 7, text: "$review" },
          snapshot: SkillInvocation.Snapshot.make({
            id: SkillInvocation.ID.make("ski_retry"),
            name: "review",
            digest: Skill.Digest.make("3".repeat(64)),
            source: { kind: "imported", label: "Imported" },
            content: "Original body",
            status: "loaded",
          }),
        },
      ],
    })
    expect(SkillSlashCompatibility.retryEquivalent(recorded, expected, "review")).toBe(true)
    expect(SkillSlashCompatibility.retryEquivalent(recorded, Prompt.make({ text: "$review changed" }), "review")).toBe(
      false,
    )
  })
})
