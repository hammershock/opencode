import { describe, expect, test } from "bun:test"
import { skillDisplayLabel, structuredSkillMentions } from "../../src/prompt/skill"

const catalog = [
  { id: "one", name: "review", sourceLabel: "OpenCode", digest: "a" },
  { id: "two", name: "deploy", sourceLabel: "OpenCode", digest: "b" },
]

describe("skillDisplayLabel", () => {
  test("only adds source labels when names collide", () => {
    expect(skillDisplayLabel(catalog[1]!, catalog)).toBe("$deploy")
    expect(skillDisplayLabel(catalog[0]!, [...catalog, { ...catalog[0]!, id: "duplicate" }])).toBe("$review · OpenCode")
  })
})

describe("structuredSkillMentions", () => {
  const skill = (start: number, end: number, value = "$review") => ({
    type: "skill" as const,
    id: `skl_${"a".repeat(64)}`,
    name: "review",
    sourceLabel: "OpenCode",
    digest: "b".repeat(64),
    source: { start, end, value },
  })

  test("converts display offsets without losing Unicode prefixes", () => {
    expect(structuredSkillMentions("中文 $review", [skill(5, 12)])).toEqual([
      { id: `skl_${"a".repeat(64)}`, name: "review", source: { start: 3, end: 10, text: "$review" } },
    ])
  })

  test("accounts for expanded pasted placeholders before a selected token", () => {
    expect(
      structuredSkillMentions("[Pasted ~3 lines] $review", [
        {
          type: "text",
          text: "first\nsecond\nthird",
          source: { text: { start: 0, end: 17, value: "[Pasted ~3 lines]" } },
        },
        skill(18, 25),
      ]),
    ).toEqual([{ id: `skl_${"a".repeat(64)}`, name: "review", source: { start: 19, end: 26, text: "$review" } }])
  })

  test("does not infer pasted text or retain edited stale tokens", () => {
    expect(structuredSkillMentions("pasted $review", [])).toEqual([])
    expect(structuredSkillMentions("$revise", [skill(0, 7)])).toEqual([])
  })
})
