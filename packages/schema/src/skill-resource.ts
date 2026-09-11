export * as SkillResource from "./skill-resource"

import { Schema } from "effect"
import { NonNegativeInt, optional, RelativePath } from "./schema"
import { Skill } from "./skill"
import { SkillInvocation } from "./skill-invocation"

export const MAX_MANIFEST_ENTRIES = 100
export const MAX_MANIFEST_SCAN_ENTRIES = 1_000
export const MAX_MANIFEST_BYTES = 16 * 1024
export const MAX_RESOURCE_BYTES = 1024 * 1024
export const MAX_PAGE_BYTES = 16 * 1024

export const Reference = Schema.Union([Skill.ID, SkillInvocation.ID]).annotate({
  identifier: "SkillResource.Reference",
})
export type Reference = typeof Reference.Type

export const Input = Schema.Struct({
  skill: Reference.annotate({ description: "An admitted Skill invocation ID or a local Skill ID" }),
  resource: Schema.String.pipe(optional).annotate({
    description: "A canonical relative path inside the Skill package; omit to list resources",
  }),
  cursor: Schema.String.pipe(optional).annotate({ description: "Opaque cursor returned by a previous call" }),
}).annotate({ identifier: "SkillResource.Input" })
export type Input = typeof Input.Type

export interface Identity extends Schema.Schema.Type<typeof Identity> {}
export const Identity = Schema.Struct({
  invocationID: SkillInvocation.ID.pipe(optional),
  skillID: Skill.ID,
  name: Schema.String,
  digest: Skill.Digest,
}).annotate({ identifier: "SkillResource.Identity" })

export interface Entry extends Schema.Schema.Type<typeof Entry> {}
export const Entry = Schema.Struct({
  resource: RelativePath,
  size: NonNegativeInt,
  mime: Schema.String,
}).annotate({ identifier: "SkillResource.Entry" })

export interface Manifest extends Schema.Schema.Type<typeof Manifest> {}
export const Manifest = Schema.Struct({
  type: Schema.Literal("manifest"),
  skill: Identity,
  entries: Schema.Array(Entry),
  truncated: Schema.Boolean,
  nextCursor: Schema.String.pipe(optional),
  diagnostic: Schema.Literal("manifest_limit").pipe(optional),
}).annotate({ identifier: "SkillResource.Manifest" })

export interface Text extends Schema.Schema.Type<typeof Text> {}
export const Text = Schema.Struct({
  type: Schema.Literal("text"),
  skill: Identity,
  resource: RelativePath,
  mime: Schema.String,
  size: NonNegativeInt,
  digest: Skill.Digest,
  content: Schema.String,
  truncated: Schema.Boolean,
  nextCursor: Schema.String.pipe(optional),
}).annotate({ identifier: "SkillResource.Text" })

export const UnsupportedDiagnostic = Schema.Literals(["binary", "resource_too_large"])
export type UnsupportedDiagnostic = typeof UnsupportedDiagnostic.Type

export interface Unsupported extends Schema.Schema.Type<typeof Unsupported> {}
export const Unsupported = Schema.Struct({
  type: Schema.Literal("unsupported"),
  skill: Identity,
  resource: RelativePath,
  mime: Schema.String,
  size: NonNegativeInt,
  digest: Skill.Digest.pipe(optional),
  diagnostic: UnsupportedDiagnostic,
}).annotate({ identifier: "SkillResource.Unsupported" })

export const Output = Schema.Union([Manifest, Text, Unsupported]).pipe(
  Schema.toTaggedUnion("type"),
  Schema.annotate({ identifier: "SkillResource.Output" }),
)
export type Output = Manifest | Text | Unsupported

export const FailureKind = Schema.Literals([
  "resource_unavailable_on_device",
  "ambiguous_skill",
  "permission_denied",
  "skill_inapplicable",
  "invalid_resource_path",
  "resource_not_found",
  "resource_outside_package",
  "unsupported_resource_type",
  "invalid_cursor",
])
export type FailureKind = typeof FailureKind.Type
