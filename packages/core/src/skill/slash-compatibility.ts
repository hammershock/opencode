export * as SkillSlashCompatibility from "./slash-compatibility"

import { Prompt } from "@opencode-ai/schema/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { Skill } from "@opencode-ai/schema/skill"
import { Schema } from "effect"

export interface Input {
  readonly name: string
  readonly arguments: string
  readonly files?: ReadonlyArray<PromptInput.FileAttachment>
}

const Candidate = Schema.Struct({
  id: Skill.ID,
  sourceLabel: Schema.String,
  digest: Skill.Digest,
})

export class Error extends Schema.TaggedErrorClass<Error>()("SkillSlashCompatibility.Error", {
  kind: Schema.Literals(["unavailable", "ambiguous"]),
  name: Schema.String,
  candidates: Schema.Array(Candidate),
}) {}

export function resolve(input: Input, skills: ReadonlyArray<Skill.Metadata>) {
  const candidates = skills
    .filter((skill) => skill.name === input.name)
    .toSorted(
      (a, b) =>
        a.sourceLabel.localeCompare(b.sourceLabel) || a.digest.localeCompare(b.digest) || a.id.localeCompare(b.id),
    )
  if (candidates.length !== 1)
    return new Error({
      kind: candidates.length === 0 ? "unavailable" : "ambiguous",
      name: input.name,
      candidates: candidates.map((skill) => ({
        id: skill.id,
        sourceLabel: skill.sourceLabel,
        digest: skill.digest,
      })),
    })

  const source = mention(input.name)
  return PromptInput.Prompt.make({
    ...request(input),
    skills: [
      PromptInput.SkillMention.make({
        id: candidates[0]!.id,
        name: input.name,
        source,
      }),
    ],
  })
}

export function request(input: Input) {
  return PromptInput.Prompt.make({
    text: text(input),
    ...(input.files === undefined ? {} : { files: input.files }),
  })
}

export function retryEquivalent(recorded: Prompt, expected: Prompt, name: string) {
  const base = Prompt.make({
    text: recorded.text,
    ...(recorded.files === undefined ? {} : { files: recorded.files }),
    ...(recorded.agents === undefined ? {} : { agents: recorded.agents }),
  })
  const normalized = Prompt.make({
    text: expected.text,
    ...(expected.files === undefined ? {} : { files: expected.files }),
    ...(expected.agents === undefined ? {} : { agents: expected.agents }),
  })
  if (!Prompt.equivalence(base, normalized)) return false
  const invocation = recorded.invocations?.[0]
  const source = mention(name)
  return (
    recorded.invocations?.length === 1 &&
    invocation?.snapshot.name === name &&
    invocation.source.start === source.start &&
    invocation.source.end === source.end &&
    invocation.source.text === source.text
  )
}

function mention(name: string) {
  const value = `$${name}`
  return { start: 0, end: value.length, text: value }
}

function text(input: Input) {
  const value = `$${input.name}`
  return input.arguments.length === 0 ? value : `${value} ${input.arguments}`
}
