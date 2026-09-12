import type {
  AgentPart,
  AssistantMessage,
  FilePart,
  Message,
  Part,
  SessionMessage,
  SessionMessageAssistantTool,
  SessionMessageUser,
  SkillMetadata,
  TextPart,
  UserMessage,
} from "@opencode-ai/sdk/v2"
import type { PromptInfo, SkillMentionPart } from "../prompt/history"

export function canonicalUserText(message: SessionMessageUser) {
  return message.text
}

export function commitCanonicalRevert(messages: readonly SessionMessage[], messageID: string) {
  const boundary = messages.findIndex((message) => message.id === messageID)
  return boundary === -1 ? messages : messages.slice(boundary + 1)
}

export function restoreCanonicalPrompt(message: SessionMessageUser, catalog: readonly SkillMetadata[]) {
  const skills: ({ part: SkillMentionPart } | { missing: string })[] = (message.skills ?? []).map((invocation) => {
    const metadata = catalog.find(
      (skill) =>
        skill.name === invocation.snapshot.name &&
        skill.digest === invocation.snapshot.digest &&
        skill.sourceLabel.replace(/ · [0-9a-f]{8}$/i, "") === invocation.snapshot.source.label,
    )
    if (!metadata) return { missing: invocation.snapshot.name }
    return {
      part: {
        type: "skill" as const,
        id: metadata.id,
        name: metadata.name,
        description: metadata.description,
        sourceLabel: metadata.sourceLabel,
        digest: metadata.digest,
        source: {
          start: invocation.source.start,
          end: invocation.source.end,
          value: invocation.source.text,
        },
      },
    }
  })
  const missing = skills.find((skill) => "missing" in skill)?.missing
  if (missing) return { missing }

  return {
    prompt: {
      input: message.text,
      parts: [
        ...(message.files ?? []).map((file) => ({
          type: "file" as const,
          mime: file.mime,
          filename: file.name,
          url: file.uri,
          description: file.description,
          source: file.source
            ? {
                type: "file" as const,
                path: file.name ?? file.uri,
                text: { value: file.source.text, start: file.source.start, end: file.source.end },
              }
            : undefined,
        })),
        ...(message.agents ?? []).map((agent) => ({
          type: "agent" as const,
          name: agent.name,
          source: agent.source
            ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
            : undefined,
        })),
        ...skills.flatMap((skill) => ("part" in skill ? [skill.part] : [])),
      ],
    } satisfies PromptInfo,
  }
}

export function projectCanonicalSessionMessages(input: {
  sessionID: string
  directory: string
  agent: string
  model?: { providerID: string; id: string; variant?: string }
  messages: readonly SessionMessage[]
}) {
  let parentID = ""
  return input.messages.toReversed().flatMap((item) => {
    if (item.type === "user") {
      parentID = item.id
      const message = {
        id: item.id,
        sessionID: input.sessionID,
        role: "user",
        time: item.time,
        agent: input.agent,
        model: {
          providerID: input.model?.providerID ?? "unknown",
          modelID: input.model?.id ?? "unknown",
          variant: input.model?.variant,
        },
      } satisfies UserMessage
      const parts: Part[] = [
        {
          id: `${item.id}-text`,
          sessionID: input.sessionID,
          messageID: item.id,
          type: "text",
          text: item.text,
        } satisfies TextPart,
        ...(item.files ?? []).map(
          (file, index) =>
            ({
              id: `${item.id}-file-${index}`,
              sessionID: input.sessionID,
              messageID: item.id,
              type: "file",
              mime: file.mime,
              filename: file.name,
              url: file.uri,
              source: file.source
                ? {
                    type: "file",
                    path: file.name ?? file.uri,
                    text: { value: file.source.text, start: file.source.start, end: file.source.end },
                  }
                : undefined,
            }) satisfies FilePart,
        ),
        ...(item.agents ?? []).map(
          (agent, index) =>
            ({
              id: `${item.id}-agent-${index}`,
              sessionID: input.sessionID,
              messageID: item.id,
              type: "agent",
              name: agent.name,
              source: agent.source
                ? { value: agent.source.text, start: agent.source.start, end: agent.source.end }
                : undefined,
            }) satisfies AgentPart,
        ),
      ]
      return [{ message: message as Message, parts }]
    }
    if (item.type !== "assistant") return []
    const message = {
      id: item.id,
      sessionID: input.sessionID,
      role: "assistant",
      time: item.time,
      parentID,
      modelID: item.model.id,
      providerID: item.model.providerID,
      mode: item.agent,
      agent: item.agent,
      path: { cwd: input.directory, root: input.directory },
      cost: item.cost ?? 0,
      tokens: item.tokens ?? { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      variant: item.model.variant,
      finish: item.finish,
      error: item.error ? { name: "UnknownError", data: { message: item.error.message } } : undefined,
    } satisfies AssistantMessage
    const parts = item.content.map((content): Part => {
      if (content.type === "text")
        return {
          id: content.id,
          sessionID: input.sessionID,
          messageID: item.id,
          type: "text",
          text: content.text,
        }
      if (content.type === "reasoning")
        return {
          id: content.id,
          sessionID: input.sessionID,
          messageID: item.id,
          type: "reasoning",
          text: content.text,
          metadata: content.providerMetadata,
          time: {
            start: content.time?.created ?? item.time.created,
            end: content.time?.completed ?? item.time.completed,
          },
        }
      return projectTool(input.sessionID, item.id, content)
    })
    return [{ message: message as Message, parts }]
  })
}

export function mergeCanonicalSessionMessages(legacy: readonly Message[], canonical: readonly Message[]) {
  const projected = new Set(canonical.map((message) => message.id))
  const live = new Map(legacy.map((message) => [message.id, message]))
  const messages = [
    ...canonical.map((message) => live.get(message.id) ?? message),
    ...legacy.filter((message) => !projected.has(message.id)),
  ]
  const users = new Map(messages.flatMap((message) => (message.role === "user" ? [[message.id, message]] : [])))
  return messages.toSorted((left, right) => {
    const leftUser = (left.role === "assistant" ? users.get(left.parentID) : left) ?? left
    const rightUser = (right.role === "assistant" ? users.get(right.parentID) : right) ?? right
    const turn = leftUser.time.created - rightUser.time.created || leftUser.id.localeCompare(rightUser.id)
    if (turn !== 0) return turn
    if (left.role !== right.role) return left.role === "user" ? -1 : 1
    return left.time.created - right.time.created || left.id.localeCompare(right.id)
  })
}

function projectTool(sessionID: string, messageID: string, tool: SessionMessageAssistantTool): Part {
  const base = {
    id: tool.id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: tool.id,
    tool: tool.name,
  }
  if (tool.state.status === "pending")
    return { ...base, state: { status: "pending", input: {}, raw: tool.state.input } }
  if (tool.state.status === "running")
    return {
      ...base,
      state: {
        status: "running",
        input: tool.state.input,
        title: tool.name,
        metadata: tool.state.structured,
        time: { start: tool.time.ran ?? tool.time.created },
      },
    }
  if (tool.state.status === "error")
    return {
      ...base,
      state: {
        status: "error",
        input: tool.state.input,
        error: tool.state.error.message,
        metadata: tool.state.structured,
        time: { start: tool.time.ran ?? tool.time.created, end: tool.time.completed ?? tool.time.created },
      },
    }
  return {
    ...base,
    state: {
      status: "completed",
      input: tool.state.input,
      output: tool.state.content.flatMap((content) => (content.type === "text" ? [content.text] : [])).join("\n"),
      title: tool.name,
      metadata: tool.state.structured,
      time: { start: tool.time.ran ?? tool.time.created, end: tool.time.completed ?? tool.time.created },
    },
  }
}
