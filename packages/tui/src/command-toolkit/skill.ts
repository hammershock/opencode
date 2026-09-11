import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type SkillCommandContext = InvocationContext & {
  openSkillManager: () => void
}

const empty = (raw: RawArguments) =>
  raw.value.trim()
    ? ({
        status: "invalid",
        code: "unexpected_arguments",
        message: "Usage: /skills",
        range: raw.range,
      } as const)
    : ({ status: "parsed", input: undefined } as const)

export const skillCommand = defineCommand<void, SkillCommandContext>({
  id: "fork.skill.manage",
  path: ["skills"],
  title: "Manage skills",
  description: "Manage local discovery paths, diagnostics, and target access",
  category: "Skills",
  provenance: { type: "core", feature: "skill-registry" },
  capabilities: ["skill.registry.read", "skill.registry.write"],
  parse: empty,
  execute: async (ctx) => {
    ctx.openSkillManager()
    return { status: "completed" }
  },
})
