export * as SkillCatalogContext from "./catalog-context"

import { Effect, Layer, Ref } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { makeLocationNode } from "../effect/app-node"
import { PluginV2 } from "../plugin"
import { SkillV2 } from "../skill"
import { SkillCatalogContextService } from "./catalog-context-service"
import { AgentV2 } from "../agent"
import { SkillRegistry } from "./registry"
import { SkillGuidanceSnapshot } from "./guidance-snapshot"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { Hash } from "../util/hash"

export type { Loaded, Interface } from "./catalog-context-service"
export { Service } from "./catalog-context-service"

const layer = Layer.effect(
  SkillCatalogContextService.Service,
  Effect.gen(function* () {
    const plugin = yield* PluginV2.Service
    const skills = yield* SkillV2.Service
    const agents = yield* AgentV2.Service
    const registry = yield* SkillRegistry.Service
    const current = yield* Ref.make<Skill.RegistrySnapshot | undefined>(undefined)

    return SkillCatalogContextService.Service.of({
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
      resolve: Effect.fn("SkillCatalogContext.resolve")(function* (input) {
        const invalid = validate(input.text, input.mentions)
        if (invalid) return yield* invalid
        const agent = yield* agents.select(input.agent)
        return yield* Effect.forEach(SkillCatalogContextService.normalize(input.mentions), (mention) =>
          Effect.gen(function* () {
            const match = yield* skills.lookup(mention.id)
            if (match.status === "missing")
              return yield* new SkillCatalogContextService.AdmissionError({
                kind: "unavailable",
                skillID: mention.id,
                name: mention.name,
              })
            if (match.status === "target-inapplicable")
              return yield* new SkillCatalogContextService.AdmissionError({
                kind: "target-inapplicable",
                skillID: mention.id,
                name: mention.name,
              })
            if (match.entry.metadata.name !== mention.name)
              return yield* new SkillCatalogContextService.AdmissionError({
                kind: "invalid-mention",
                skillID: mention.id,
                name: mention.name,
              })
            if (!agent.info || SkillV2.available([match.entry.metadata], agent.info).length === 0)
              return yield* new SkillCatalogContextService.AdmissionError({
                kind: "permission-denied",
                skillID: mention.id,
                name: mention.name,
              })
            if (!SkillGuidanceSnapshot.admitted(input.catalog, match.entry.metadata))
              return yield* new SkillCatalogContextService.AdmissionError({
                kind: "stale-catalog",
                skillID: mention.id,
                name: mention.name,
              })
            const entry = yield* registry.read(match.entry).pipe(
              Effect.mapError(
                (error) =>
                  new SkillCatalogContextService.AdmissionError({
                    kind: error.kind,
                    skillID: mention.id,
                    name: mention.name,
                  }),
              ),
            )
            const sourceLabel = SkillGuidanceSnapshot.sourceLabel(entry.metadata.sourceLabel)
            return {
              source: mention.source,
              snapshot: SkillInvocation.Snapshot.make({
                id: SkillInvocation.ID.make(
                  `ski_${Hash.sha256(
                    `${input.sessionID}\0${input.messageID}\0${entry.metadata.name}\0${entry.metadata.digest}\0${sourceLabel}\0${mention.source.start}`,
                  )}`,
                ),
                name: entry.metadata.name,
                description: entry.metadata.description,
                digest: entry.metadata.digest,
                source: { kind: entry.source.kind, label: sourceLabel },
                content: entry.content,
                status: "loaded",
              }),
            }
          }),
        )
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: SkillCatalogContextService.Service,
  layer,
  deps: [PluginV2.node, SkillV2.node, AgentV2.node, SkillRegistry.node],
})

function validate(text: string, mentions: SkillCatalogContextService.AdmissionInput["mentions"]) {
  const ordered = mentions.toSorted((a, b) => a.source.start - b.source.start || a.source.end - b.source.end)
  for (const [index, mention] of ordered.entries()) {
    const validRange =
      Number.isInteger(mention.source.start) &&
      Number.isInteger(mention.source.end) &&
      mention.source.start >= 0 &&
      mention.source.end > mention.source.start &&
      mention.source.end <= text.length
    const previous = ordered[index - 1]
    if (
      !validRange ||
      text.slice(mention.source.start, mention.source.end) !== mention.source.text ||
      mention.source.text !== `$${mention.name}` ||
      (previous !== undefined && previous.source.end > mention.source.start)
    )
      return new SkillCatalogContextService.AdmissionError({
        kind: "invalid-mention",
        skillID: mention.id,
        name: mention.name,
      })
  }
}

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
