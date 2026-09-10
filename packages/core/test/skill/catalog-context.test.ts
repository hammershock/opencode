import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillCatalogContext } from "@opencode-ai/core/skill/catalog-context"
import { it } from "../lib/effect"

const digest = (value: string) => Skill.Digest.make(value.repeat(64))
const metadata = (name: string, value: string) =>
  Skill.Metadata.make({
    id: Skill.ID.make(`skl_${value.repeat(64)}`),
    name,
    description: `${name} description`,
    sourceLabel: `Imported · ${value.repeat(8)}`,
    digest: digest(value),
  })
const snapshot = (skills: Skill.Metadata[], diagnostics: Skill.Diagnostic[] = []) =>
  Skill.RegistrySnapshot.make({ revision: digest("a"), digest: digest("a"), skills, diagnostics })

describe("SkillCatalogContext", () => {
  it.effect("force reloads once, reuses the current snapshot, and retains it on transient failure", () => {
    let waits = 0
    let reloads = 0
    let reads = 0
    let current = snapshot([metadata("review", "1")])
    const layer = AppNodeBuilder.build(SkillCatalogContext.node, [
      [
        PluginV2.node,
        Layer.mock(PluginV2.Service, {
          wait: () => Effect.sync(() => waits++),
        }),
      ],
      [
        SkillV2.node,
        Layer.mock(SkillV2.Service, {
          reload: () => Effect.sync(() => reloads++),
          catalog: () =>
            Effect.sync(() => {
              reads++
              return { snapshot: current, entries: [] }
            }),
        }),
      ],
    ])

    return Effect.gen(function* () {
      const catalogs = yield* SkillCatalogContext.Service
      const first = yield* catalogs.load({ forceReload: true })
      const cached = yield* catalogs.load({ forceReload: false })

      expect(first.snapshot.skills.map((skill) => skill.name)).toEqual(["review"])
      expect(cached.snapshot).toBe(first.snapshot)
      expect({ waits, reloads, reads }).toEqual({ waits: 2, reloads: 1, reads: 1 })

      current = snapshot(
        [],
        [
          Skill.Diagnostic.make({
            kind: "root-unavailable",
            severity: "warning",
            sourceLabel: "Imported",
            message: "private path intentionally omitted from activation diagnostics",
          }),
        ],
      )
      const retained = yield* catalogs.load({ forceReload: true })

      expect(retained.transient).toBe(true)
      expect(retained.snapshot).toBe(first.snapshot)
      expect(retained.diagnostics).toEqual([{ kind: "root-unavailable", severity: "warning", sourceLabel: "Imported" }])
      expect({ waits, reloads, reads }).toEqual({ waits: 3, reloads: 2, reads: 2 })
    }).pipe(Effect.provide(layer))
  })
})
