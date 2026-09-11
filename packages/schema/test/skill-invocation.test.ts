import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Prompt } from "../src/prompt"
import { PromptInput } from "../src/prompt-input"
import { Skill } from "../src/skill"
import { SkillInvocation } from "../src/skill-invocation"

describe("Skill invocation contracts", () => {
  test("keeps device-local mentions separate from portable durable snapshots", () => {
    const mention = PromptInput.SkillMention.make({
      id: Skill.ID.make(`skl_${"1".repeat(64)}`),
      name: "review",
      source: { start: 0, end: 7, text: "$review" },
    })
    const snapshot = SkillInvocation.Snapshot.make({
      id: SkillInvocation.ID.make("ski_snapshot"),
      name: "review",
      digest: Skill.Digest.make("2".repeat(64)),
      source: { kind: "imported", label: "Imported" },
      content: "Review the patch",
      status: "loaded",
    })
    const input = PromptInput.Prompt.make({ text: "$review patch", skills: [mention] })
    const durable = Prompt.make({
      text: input.text,
      invocations: [{ source: mention.source, snapshot }],
    })
    const encoded = Schema.encodeSync(Prompt)(durable)

    expect(encoded).toEqual({
      text: "$review patch",
      invocations: [{ source: mention.source, snapshot }],
    })
    expect(JSON.stringify(encoded)).not.toContain("skl_")
    expect(Schema.decodeUnknownSync(Prompt)(encoded)).toEqual(durable)
  })

  test("requires the Session invocation ID prefix", () => {
    expect(() => Schema.decodeUnknownSync(SkillInvocation.ID)("skl_wrong")).toThrow()
    expect(SkillInvocation.ID.create()).toStartWith("ski_")
  })
})
