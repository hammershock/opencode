import { describe, expect, test } from "bun:test"
import {
  admittedSkills,
  bareSkillMentions,
  resolveSubmittedSkillMentions,
  resolveSkillMentions,
  skillCatalogInput,
  skillDisplayLabel,
  structuredSkillMentions,
} from "../../src/prompt/skill"

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

describe("skillCatalogInput", () => {
  test("waits for a QuickStart Agent and includes it in the reactive request input", () => {
    expect(skillCatalogInput(false, { agent: "build" })).toBeUndefined()
    expect(skillCatalogInput(true, {})).toBeUndefined()
    expect(skillCatalogInput(true, { agent: "build", location: { directory: "/project" } })).toEqual({
      agent: "build",
      location: { directory: "/project" },
    })
    expect(skillCatalogInput(true, { sessionID: "ses_test" })).toEqual({ sessionID: "ses_test" })
  })
})

describe("admittedSkills", () => {
  test("filters by exact device-local identity and expected metadata", () => {
    const collision = { id: "three", name: "review", sourceLabel: "OpenCode", digest: "a" }
    expect(
      admittedSkills([...catalog, collision], {
        skills: [catalog[0]!, { ...catalog[1]!, digest: "stale" }],
      }),
    ).toEqual([catalog[0]])
  })

  test("does not treat an identical name, source label, and digest as identity proof", () => {
    const collision = { ...catalog[0]!, id: "collision" }
    expect(admittedSkills([catalog[0]!, collision], { skills: [catalog[0]!] })).toEqual([catalog[0]])
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

describe("bareSkillMentions", () => {
  test("finds valid token boundaries and preserves expanded paste offsets", () => {
    expect(bareSkillMentions("Use ($deploy), then $verify.", [])).toEqual([
      { name: "deploy", source: { start: 5, end: 12, text: "$deploy" }, display: { start: 5, end: 12 } },
      { name: "verify", source: { start: 20, end: 27, text: "$verify" }, display: { start: 20, end: 27 } },
    ])
    expect(
      bareSkillMentions("[Pasted ~3 lines] $deploy", [
        {
          type: "text",
          text: "first\nsecond\nthird",
          source: { text: { start: 0, end: 17, value: "[Pasted ~3 lines]" } },
        },
      ]),
    ).toEqual([{ name: "deploy", source: { start: 19, end: 26, text: "$deploy" }, display: { start: 18, end: 25 } }])
  })

  test("ignores escaped, code, email, word-interior, and malformed tokens", () => {
    expect(bareSkillMentions(String.raw`\$deploy`, [])).toEqual([])
    expect(bareSkillMentions(String.raw`\\$verify`, [])).toEqual([
      { name: "verify", source: { start: 2, end: 9, text: "$verify" }, display: { start: 2, end: 9 } },
    ])
    expect(bareSkillMentions("`$deploy` and ``$verify``", [])).toEqual([])
    expect(
      bareSkillMentions("mail$deploy@example.test $deploy@example.test foo_$deploy $deploy_more $deploy-", []),
    ).toEqual([])
  })

  test("does not reinterpret a picker-backed token", () => {
    const id = `skl_${"a".repeat(64)}`
    expect(
      bareSkillMentions("$review and $deploy", [
        {
          type: "skill",
          id,
          name: "review",
          sourceLabel: "OpenCode",
          digest: "b".repeat(64),
          source: { start: 0, end: 7, value: "$review" },
        },
      ]),
    ).toEqual([{ name: "deploy", source: { start: 12, end: 19, text: "$deploy" }, display: { start: 12, end: 19 } }])
  })
})

describe("resolveSkillMentions", () => {
  const skills = [
    ...catalog,
    { id: "three", name: "review", sourceLabel: "Imported", digest: "c" },
    { id: "four", name: "verify", sourceLabel: "OpenCode", digest: "d" },
  ]

  test("resolves unique names and leaves unknown names as text", () => {
    expect(resolveSkillMentions("Use $deploy and $unknown.", [], skills)).toEqual({
      mentions: [{ id: "two", name: "deploy", source: { start: 4, end: 11, text: "$deploy" } }],
    })
  })

  test("blocks the first ambiguous name with its display range", () => {
    expect(resolveSkillMentions("Use $review now", [], skills)).toEqual({
      mentions: [],
      ambiguous: {
        name: "review",
        source: { start: 4, end: 11, text: "$review" },
        display: { start: 4, end: 11 },
      },
    })
  })

  test("keeps first-appearance order, gives structured parts priority, and deduplicates IDs", () => {
    const id = `skl_${"a".repeat(64)}`
    const part = {
      type: "skill" as const,
      id,
      name: "review",
      sourceLabel: "OpenCode",
      digest: "b".repeat(64),
      source: { start: 8, end: 15, value: "$review" },
    }
    expect(resolveSkillMentions("$deploy $review $deploy", [part], skills)).toEqual({
      mentions: [
        { id: "two", name: "deploy", source: { start: 0, end: 7, text: "$deploy" } },
        { id, name: "review", source: { start: 8, end: 15, text: "$review" } },
      ],
    })
  })
})

describe("resolveSubmittedSkillMentions", () => {
  test("loads the current catalog for bare tokens and returns exact mentions", async () => {
    let loads = 0
    expect(
      await resolveSubmittedSkillMentions({
        text: "$deploy now",
        parts: [],
        shell: false,
        load: async () => {
          loads++
          return catalog
        },
        show: () => {},
      }),
    ).toEqual([{ id: "two", name: "deploy", source: { start: 0, end: 7, text: "$deploy" } }])
    expect(loads).toBe(1)
  })

  test("blocks ambiguous submission and reopens the exact token", async () => {
    const shown: { start: number; end: number }[] = []
    expect(
      await resolveSubmittedSkillMentions({
        text: "Use $review now",
        parts: [],
        shell: false,
        load: async () => [...catalog, { ...catalog[0], id: "three" }],
        show: (source) => shown.push(source),
      }),
    ).toBeUndefined()
    expect(shown).toEqual([{ start: 4, end: 11 }])
  })

  test("does not load or infer bare tokens in shell mode", async () => {
    let loads = 0
    expect(
      await resolveSubmittedSkillMentions({
        text: "$deploy now",
        parts: [],
        shell: true,
        load: async () => {
          loads++
          return catalog
        },
        show: () => {},
      }),
    ).toEqual([])
    expect(loads).toBe(0)
  })

  test("blocks submission when the current catalog cannot be loaded", async () => {
    expect(
      await resolveSubmittedSkillMentions({
        text: "$deploy now",
        parts: [],
        shell: false,
        load: async () => undefined,
        show: () => {},
      }),
    ).toBeUndefined()
  })
})
