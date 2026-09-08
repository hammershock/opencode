import { Identifier } from "@opencode-ai/core/id/id"
import type { AgentPartInput, FilePartInput, Part, TextPartInput, UserMessage } from "@opencode-ai/sdk/v2"

type InputPart = TextPartInput | FilePartInput | AgentPartInput

export function optimisticPrompt(input: {
  sessionID: string
  agent: string
  model: { providerID: string; modelID: string }
  variant?: string
  parts: readonly InputPart[]
}) {
  const messageID = Identifier.ascending("message")
  const requestParts = input.parts.map((part) => ({ ...part, id: part.id ?? Identifier.ascending("part") }))
  const message: UserMessage = {
    id: messageID,
    sessionID: input.sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: input.agent,
    model: { ...input.model, variant: input.variant },
  }
  const parts = requestParts.map((part) => ({ ...part, messageID, sessionID: input.sessionID })) as Part[]
  return { message, parts, requestParts }
}
