export * as SkillInvocation from "./skill-invocation"

import { Schema } from "effect"
import { ascending } from "./identifier"
import { optional, statics } from "./schema"
import { Skill } from "./skill"

export const ID = Schema.String.check(Schema.isPattern(/^ski_[0-9A-Za-z]+$/)).pipe(
  Schema.brand("Session.SkillInvocationID"),
  statics((schema) => ({ create: () => schema.make(`ski_${ascending()}`) })),
)
export type ID = typeof ID.Type

export interface Source extends Schema.Schema.Type<typeof Source> {}
export const Source = Schema.Struct({
  kind: Skill.SourceKind,
  label: Schema.String,
}).annotate({ identifier: "Session.SkillInvocationSource" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  id: ID,
  name: Schema.String,
  description: Schema.String.pipe(optional),
  digest: Skill.Digest,
  source: Source,
  content: Schema.String,
  status: Schema.Literal("loaded"),
}).annotate({ identifier: "Session.SkillInvocationSnapshot" })
