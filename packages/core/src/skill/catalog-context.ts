export * as SkillCatalogContext from "./catalog-context"

import { Context, Effect, Layer, Ref } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { makeLocationNode } from "../effect/app-node"
import { PluginV2 } from "../plugin"
import { SkillV2 } from "../skill"

export interface Loaded {
  readonly snapshot: Skill.RegistrySnapshot
  readonly diagnostics: ReadonlyArray<Skill.ActivationDiagnostic>
  readonly transient: boolean
}

export interface Interface {
  readonly load: (input: { readonly forceReload: boolean }) => Effect.Effect<Loaded>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillCatalogContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const skills = yield* SkillV2.Service
    const current = yield* Ref.make<Skill.RegistrySnapshot | undefined>(undefined)

    return Service.of({
      load: Effect.fn("SkillCatalogContext.load")(function* (input) {
        yield* plugin.wait(PluginV2.ID.make("config-skill"))
        const cached = yield* Ref.get(current)
        const observed = input.forceReload
          ? yield* skills.reload().pipe(
              Effect.andThen(skills.catalog({ forceReload: true })),
              Effect.map((result) => result.snapshot),
            )
          : (cached ?? (yield* skills.catalog().pipe(Effect.map((result) => result.snapshot))))
        const transient = observed.diagnostics.some(isTransient)
        const snapshot = transient && cached ? cached : observed
        if (!transient || !cached) yield* Ref.set(current, observed)
        return {
          snapshot,
          diagnostics: observed.diagnostics.map(redact).toSorted(compareDiagnostic),
          transient,
        }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginV2.node, SkillV2.node],
})

function redact(diagnostic: Skill.Diagnostic) {
  return Skill.ActivationDiagnostic.make({
    kind: diagnostic.kind,
    severity: diagnostic.severity,
    sourceLabel: diagnostic.sourceLabel.replace(/ · [0-9a-f]{8}$/i, ""),
  })
}

function isTransient(diagnostic: Skill.Diagnostic) {
  if (["scan-failed", "read-failed", "invalid-settings"].includes(diagnostic.kind)) return true
  return (
    diagnostic.kind === "root-unavailable" &&
    (diagnostic.sourceLabel === "Imported" || diagnostic.sourceLabel.startsWith("URL "))
  )
}

function compareDiagnostic(a: Skill.ActivationDiagnostic, b: Skill.ActivationDiagnostic) {
  return (
    a.sourceLabel.localeCompare(b.sourceLabel) || a.kind.localeCompare(b.kind) || a.severity.localeCompare(b.severity)
  )
}
