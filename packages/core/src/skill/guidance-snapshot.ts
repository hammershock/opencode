export * as SkillGuidanceSnapshot from "./guidance-snapshot"

import { Schema } from "effect"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { Skill } from "@opencode-ai/schema/skill"
import { optional } from "../schema"

export const Summary = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  sourceLabel: Schema.String,
  digest: Skill.Digest,
})

export const Diagnostic = Schema.Struct({
  kind: Skill.DiagnosticKind,
  severity: Schema.Literals(["error", "warning"]),
  sourceLabel: Schema.String,
})

export const Catalog = Schema.Struct({
  enabled: Schema.Boolean,
  skills: Schema.Array(Summary),
  diagnostics: Schema.Array(Diagnostic),
})
export type Catalog = typeof Catalog.Type

export function admitted(snapshot: ModelContext.SourceState, metadata: Skill.Metadata) {
  const source = snapshot[ModelContext.Key.make("core/skill-guidance")]
  const decoded = Schema.decodeUnknownOption(Catalog)(source?.value).valueOrUndefined
  if (!decoded?.enabled) return false
  return decoded.skills.some(
    (skill) =>
      skill.name === metadata.name &&
      skill.digest === metadata.digest &&
      skill.sourceLabel === sourceLabel(metadata.sourceLabel),
  )
}

export function sourceLabel(value: string) {
  return value.replace(/ · [0-9a-f]{8}$/i, "")
}
