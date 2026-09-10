export * as Skill from "./skill"

import { Schema } from "effect"
import { AbsolutePath, optional, RelativePath } from "./schema"

export const ID = Schema.String.check(Schema.isPattern(/^skl_[0-9a-f]{64}$/)).pipe(Schema.brand("Skill.ID"))
export type ID = typeof ID.Type

export const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/)).pipe(Schema.brand("Skill.Digest"))
export type Digest = typeof Digest.Type

export const SourceKind = Schema.Literals(["built-in", "opencode-global", "opencode-project", "imported", "url"])
export type SourceKind = typeof SourceKind.Type

export interface Metadata extends Schema.Schema.Type<typeof Metadata> {}
export const Metadata = Schema.Struct({
  id: ID,
  name: Schema.String,
  description: Schema.String.pipe(optional),
  sourceLabel: Schema.String,
  digest: Digest,
}).annotate({ identifier: "Skill.Metadata" })

export interface SourceDetail extends Schema.Schema.Type<typeof SourceDetail> {}
export const SourceDetail = Schema.Struct({
  kind: SourceKind,
  label: Schema.String,
  root: AbsolutePath.pipe(optional),
  relativePath: RelativePath.pipe(optional),
}).annotate({ identifier: "Skill.SourceDetail" })

export const DiagnosticKind = Schema.Literals([
  "root-unavailable",
  "scan-failed",
  "path-escape",
  "read-failed",
  "invalid-frontmatter",
  "invalid-name",
  "name-mismatch",
  "duplicate-name",
])
export type DiagnosticKind = typeof DiagnosticKind.Type

export interface Diagnostic extends Schema.Schema.Type<typeof Diagnostic> {}
export const Diagnostic = Schema.Struct({
  kind: DiagnosticKind,
  severity: Schema.Literals(["error", "warning"]),
  sourceLabel: Schema.String,
  message: Schema.String,
  path: AbsolutePath.pipe(optional),
  skillID: ID.pipe(optional),
}).annotate({ identifier: "Skill.Diagnostic" })

export interface RegistrySnapshot extends Schema.Schema.Type<typeof RegistrySnapshot> {}
export const RegistrySnapshot = Schema.Struct({
  revision: Digest,
  skills: Schema.Array(Metadata),
  diagnostics: Schema.Array(Diagnostic),
  digest: Digest,
}).annotate({ identifier: "Skill.RegistrySnapshot" })

export interface DirectorySource extends Schema.Schema.Type<typeof DirectorySource> {}
export const DirectorySource = Schema.Struct({
  type: Schema.Literal("directory"),
  path: AbsolutePath,
}).annotate({ identifier: "SkillV2.DirectorySource" })

export interface UrlSource extends Schema.Schema.Type<typeof UrlSource> {}
export const UrlSource = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
}).annotate({ identifier: "SkillV2.UrlSource" })

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  name: Schema.String,
  description: Schema.String.pipe(optional),
  slash: Schema.Boolean.pipe(optional),
  location: AbsolutePath,
  content: Schema.String,
}).annotate({ identifier: "SkillV2.Info" })

export interface EmbeddedSource extends Schema.Schema.Type<typeof EmbeddedSource> {}
export const EmbeddedSource = Schema.Struct({
  type: Schema.Literal("embedded"),
  skill: Schema.suspend(() => Info),
}).annotate({ identifier: "SkillV2.EmbeddedSource" })

export type Source = DirectorySource | UrlSource | EmbeddedSource
export const Source = Object.assign(
  Schema.Union([DirectorySource, UrlSource, EmbeddedSource]).pipe(
    Schema.toTaggedUnion("type"),
    Schema.annotate({ identifier: "SkillV2.Source" }),
  ),
  {
    equals: (a: Source, b: Source) => {
      if (a.type !== b.type) return false
      if (a.type === "directory" && b.type === "directory") return a.path === b.path
      if (a.type === "url" && b.type === "url") return a.url === b.url
      if (a.type === "embedded" && b.type === "embedded") return a.skill.name === b.skill.name
      return false
    },
    key: (source: Source) =>
      source.type === "directory"
        ? `directory:${source.path}`
        : source.type === "url"
          ? `url:${source.url}`
          : `embedded:${source.skill.name}`,
  },
)
