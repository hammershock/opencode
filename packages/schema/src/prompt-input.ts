export * as PromptInput from "./prompt-input"

import { Schema } from "effect"
import { AgentAttachment, Source } from "./prompt"
import { optional, statics } from "./schema"
import { Skill } from "./skill"

export interface FileAttachment extends Schema.Schema.Type<typeof FileAttachment> {}
export const FileAttachment = Schema.Struct({
  uri: Schema.String,
  name: Schema.String.pipe(optional),
  description: Schema.String.pipe(optional),
  source: Source.pipe(optional),
})
  .annotate({ identifier: "PromptInput.FileAttachment" })
  .pipe(
    statics((schema) => ({
      create: (input: FileAttachment) => schema.make(input),
    })),
  )

export interface SkillMention extends Schema.Schema.Type<typeof SkillMention> {}
export const SkillMention = Schema.Struct({
  id: Skill.ID,
  name: Schema.String,
  source: Source,
}).annotate({ identifier: "Prompt.SkillMention" })

export interface Prompt extends Schema.Schema.Type<typeof Prompt> {}
export const Prompt = Schema.Struct({
  text: Schema.String,
  files: Schema.Array(FileAttachment).pipe(optional),
  agents: Schema.Array(AgentAttachment).pipe(optional),
  skills: Schema.Array(SkillMention).pipe(optional),
}).annotate({ identifier: "PromptInput" })
