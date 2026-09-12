export * as SkillGuidanceSnapshot from "./guidance-snapshot"

import { Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { NonNegativeInt, optional } from "../schema"

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
  omitted: NonNegativeInt.pipe(optional),
})
export type Catalog = typeof Catalog.Type

export function sourceLabel(value: string) {
  return value.replace(/ · [0-9a-f]{8}$/i, "")
}
