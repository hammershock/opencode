export * as SkillPresentation from "./presentation"

import { Skill } from "@opencode-ai/schema/skill"

export interface Summary {
  readonly name: string
  readonly description?: string
  readonly sourceLabel: string
  readonly digest: Skill.Digest
}

export interface Diagnostic {
  readonly kind: Skill.DiagnosticKind
  readonly severity: "error" | "warning"
  readonly sourceLabel: string
}

export interface Catalog {
  readonly enabled: boolean
  readonly skills: ReadonlyArray<Summary>
  readonly diagnostics: ReadonlyArray<Diagnostic>
  readonly omitted?: number
}

export function sourceLabel(value: string) {
  return value.replace(/ · [0-9a-f]{8}$/i, "")
}
