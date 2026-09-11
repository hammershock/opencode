export * as SkillInvocationHistory from "./invocation-history"

import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { Schema } from "effect"
import { SessionMessage } from "../session/message"

const decodeSnapshot = Schema.decodeUnknownOption(SkillInvocation.Snapshot)

export function snapshots(message: SessionMessage.Message) {
  if (message.type === "user") return (message.skills ?? []).map((invocation) => invocation.snapshot)
  if (message.type === "compaction") return message.skills ?? []
  if (message.type !== "assistant") return []
  return message.content.flatMap((item) => {
    if (item.type !== "tool" || item.name !== "skill" || item.state.status !== "completed") return []
    const snapshot = decodeSnapshot(item.state.structured.snapshot).valueOrUndefined
    return snapshot ? [snapshot] : []
  })
}
