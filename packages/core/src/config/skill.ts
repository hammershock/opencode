export * as ConfigSkill from "./skill"

import { Skill } from "@opencode-ai/schema/skill"
import { Schema } from "effect"

export const Info = Schema.Struct({
  paths: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Additional controller-local directories to discover skills from",
  }),
  urls: Schema.Array(Schema.String).pipe(Schema.optional).annotate({
    description: "Explicit HTTP or HTTPS skill sources",
  }),
  targets: Schema.Record(Skill.ID, Skill.TargetScope).pipe(Schema.optional).annotate({
    description: "Device-local target availability keyed by Skill ID",
  }),
}).annotate({ identifier: "Config.Skill" })
export type Info = typeof Info.Type
