import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type TargetCommandContext = InvocationContext & {
  openTargetManager: (mode: "manage" | "add") => void
}

const mode = (raw: RawArguments) => {
  const value = raw.value.trim()
  if (!value) return { status: "parsed", input: "manage" as const } as const
  if (value === "add") return { status: "parsed", input: "add" as const } as const
  return {
    status: "invalid",
    code: "invalid_target_action",
    message: "Usage: /target [add]",
    range: raw.range,
  } as const
}

export const targetCommand = defineCommand<"manage" | "add", TargetCommandContext>({
  id: "fork.target.manage",
  path: ["target"],
  title: "Manage execution targets",
  description: "Open target configuration without changing this Session location",
  category: "Target",
  provenance: { type: "core", feature: "target-registry" },
  capabilities: ["target.registry.read", "target.registry.write", "target.connection.test"],
  parse: mode,
  execute: async (ctx, input) => {
    ctx.openTargetManager(input)
    return { status: "completed" }
  },
})
