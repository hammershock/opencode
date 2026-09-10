export * as ConfigSkillsV1 from "./skills"

import { Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"

export const Info = Schema.Struct({
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
  targets: Schema.optional(Schema.Record(Skill.ID, Skill.TargetScope)).annotate({
    description: "Device-local target availability keyed by Skill ID",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
