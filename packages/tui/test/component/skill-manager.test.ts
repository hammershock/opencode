import { describe, expect, test } from "bun:test"
import {
  buildSkillManagerRows,
  skillRootStatus,
  skillScopeLabel,
  skillSourceLabel,
  skillTargetsLabel,
  toggleSkillTargetScope,
  type SkillManagerModel,
} from "../../src/component/skill-manager"

const firstID = `skl_${"1".repeat(64)}`
const secondID = `skl_${"2".repeat(64)}`
const dormantID = `skl_${"3".repeat(64)}`

function model(): SkillManagerModel {
  return {
    settings: {
      path: "/Users/test/.config/opencode/opencode.jsonc",
      revision: "revision",
      roots: [
        {
          kind: "opencode-global",
          value: "/Users/test/.config/opencode/skills",
          resolved: "/Users/test/.config/opencode/skills",
          default: true,
          status: "ready",
        },
        {
          kind: "imported",
          value: "/Users/test/.codex/skills",
          resolved: "/Users/test/.codex/skills",
          default: false,
          status: "undetected",
        },
      ],
      targets: { [secondID]: ["local"], [dormantID]: [] },
      diagnostics: [
        {
          kind: "missing-target",
          severity: "warning",
          field: `skills.targets.${secondID}`,
          message: "Configured target is missing on this device",
          skillID: secondID,
          targetID: "missing-target",
        },
      ],
      valid: true,
    },
    catalog: {
      revision: "catalog-revision",
      digest: "catalog-digest",
      skills: [
        { id: firstID, name: "review", sourceLabel: "OpenCode config · first", digest: "first" },
        { id: secondID, name: "review", sourceLabel: "Imported · second", digest: "second" },
      ],
      diagnostics: [
        {
          kind: "duplicate-name",
          severity: "warning",
          sourceLabel: "Registry",
          message: "Skill name is ambiguous",
        },
      ],
    },
    targets: [{ id: "configured-target", name: "a100-2gpu" }],
  }
}

describe("Skill Manager presentation", () => {
  test("uses stable status labels for roots and target scopes", () => {
    expect(skillRootStatus(model().settings.roots[0]!)).toBe("● default")
    expect(skillRootStatus(model().settings.roots[1]!)).toBe("! undetected")
    expect(skillScopeLabel(undefined)).toBe("all")
    expect(skillScopeLabel("*")).toBe("all")
    expect(skillScopeLabel([])).toBe("none")
    expect(skillScopeLabel(["local"])).toBe("local")
    expect(skillTargetsLabel(["local", "configured-target"], model().targets)).toBe("local, a100-2gpu")
    expect(skillSourceLabel("Built-in")).toBe("opencode")
    expect(skillSourceLabel("Codex · abcdef12")).toBe("codex")
    expect(skillSourceLabel("Claude · abcdef12")).toBe("claude")
    expect(skillSourceLabel("Imported · abcdef12")).toBe("others")
  })

  test("switches from future-inclusive access to an explicit checklist", () => {
    expect(toggleSkillTargetScope("*", "local", ["local", "configured-target"])).toEqual(["configured-target"])
    expect(toggleSkillTargetScope(["local"], "configured-target")).toEqual(["local", "configured-target"])
    expect(toggleSkillTargetScope(["local", "configured-target"], "local")).toEqual(["configured-target"])
    expect(toggleSkillTargetScope(["configured-target"], "configured-target")).toEqual([])
  })

  test("keeps duplicate source identity and dormant overrides visible", () => {
    const rows = buildSkillManagerRows(model(), "/Users/test")
    expect(rows.filter((row) => row.category === "Actions").map((row) => row.title)).toEqual([
      "Add path…",
      "Import Codex skills",
      "Import Claude skills",
      "Reload catalog",
      "Reset discovery paths",
    ])
    expect(rows.find((row) => row.key === "root:imported:/Users/test/.codex/skills")).toMatchObject({
      title: "~/.codex/skills",
      description: "codex",
      footer: "! undetected",
      inspectionTitle: "/Users/test/.codex/skills",
    })
    expect(rows.filter((row) => row.title === "review")).toEqual([
      expect.objectContaining({
        skill: { source: "opencode", targets: "all", state: "active" },
        details: [expect.stringContaining("Duplicate")],
      }),
      expect.objectContaining({ skill: { source: "others", targets: "local", state: "active" } }),
    ])
    expect(rows.find((row) => row.key === `skill:${dormantID}`)).toMatchObject({
      title: "Undetected Skill · 33333333",
      skill: { source: "others", targets: "none", state: "undetected" },
    })
  })

  test("bounds diagnostics without hiding their total", () => {
    const current = model()
    const expanded: SkillManagerModel = {
      ...current,
      settings: {
        ...current.settings,
        diagnostics: Array.from({ length: 22 }, (_, index) => ({
          kind: "invalid-path" as const,
          severity: "error" as const,
          field: `skills.paths.${index}`,
          message: `Invalid path ${index}`,
        })),
      },
      catalog: { ...current.catalog, diagnostics: [] },
    }
    const diagnostics = buildSkillManagerRows(expanded).filter((row) => row.category === "Diagnostics")
    expect(diagnostics).toHaveLength(21)
    expect(diagnostics.at(-1)?.title).toBe("2 more diagnostics")
  })

  test("keeps partial catalog and target failures visible", () => {
    const rows = buildSkillManagerRows({ ...model(), catalogError: "scan failed", targetError: "registry invalid" })
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "diagnostic:catalog-error", description: "scan failed" }),
    )
    expect(rows).toContainEqual(
      expect.objectContaining({ key: "diagnostic:target-error", description: "registry invalid" }),
    )
  })
})
