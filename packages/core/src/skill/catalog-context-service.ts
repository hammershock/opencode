export * as SkillCatalogContextService from "./catalog-context-service"

import { Context, Effect, Schema } from "effect"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { Prompt, SkillInvocationPart } from "@opencode-ai/schema/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { SessionMessage } from "@opencode-ai/schema/session-message"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Skill } from "@opencode-ai/schema/skill"

// Session imports this contract without pulling the Plugin implementation graph into its bundle cycle.
export interface Loaded {
  readonly snapshot: Skill.RegistrySnapshot
  readonly diagnostics: ReadonlyArray<Skill.ActivationDiagnostic>
  readonly transient: boolean
}

export interface Interface {
  readonly load: (input: { readonly forceReload: boolean; readonly includeInactive?: boolean }) => Effect.Effect<Loaded>
  readonly resolve: (input: AdmissionInput) => Effect.Effect<ReadonlyArray<SkillInvocationPart>, AdmissionError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillCatalogContext") {}

export interface AdmissionInput {
  readonly sessionID: SessionID
  readonly messageID: SessionMessage.ID
  readonly text: string
  readonly mentions: ReadonlyArray<PromptInput.SkillMention>
  readonly agent?: string
  readonly catalog: ModelContext.SourceState
  readonly admittedCatalog: Skill.AdmittedCatalog | undefined
}

export class AdmissionError extends Schema.TaggedErrorClass<AdmissionError>()("SkillAdmission.Error", {
  kind: Skill.InvocationFailureKind,
  skillID: Skill.ID,
  name: Schema.String,
}) {}

export const normalize = (mentions: ReadonlyArray<PromptInput.SkillMention>) => {
  const seen = new Set<Skill.ID>()
  return mentions
    .toSorted(
      (a, b) =>
        a.source.start - b.source.start ||
        a.source.end - b.source.end ||
        a.name.localeCompare(b.name) ||
        a.id.localeCompare(b.id),
    )
    .filter((mention) => {
      if (seen.has(mention.id)) return false
      seen.add(mention.id)
      return true
    })
}

export const retryEquivalent = (recorded: Prompt, expected: Prompt, input: ReadonlyArray<PromptInput.SkillMention>) => {
  const base = Prompt.make({
    text: recorded.text,
    files: recorded.files,
    agents: recorded.agents,
  })
  if (!Prompt.equivalence(base, expected)) return false
  const mentions = normalize(input)
  if (mentions.length !== (recorded.invocations?.length ?? 0)) return false
  return mentions.every((mention, index) => {
    const invocation = recorded.invocations?.[index]
    return (
      invocation?.snapshot.name === mention.name &&
      invocation.source.start === mention.source.start &&
      invocation.source.end === mention.source.end &&
      invocation.source.text === mention.source.text
    )
  })
}
