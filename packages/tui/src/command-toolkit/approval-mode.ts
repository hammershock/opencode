import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type ApprovalModeCommandContext = InvocationContext & {
  approvalMode: {
    open: () => Promise<void> | void
  }
}

const empty = (raw: RawArguments) =>
  raw.value.trim()
    ? ({
        status: "invalid",
        code: "unexpected_arguments",
        message: "This command accepts no arguments",
        range: raw.range,
      } as const)
    : ({ status: "parsed", input: undefined } as const)

export const approvalModeCommand = defineCommand<void, ApprovalModeCommandContext>({
  id: "fork.permission.approval-mode",
  path: ["permissions"],
  title: "Enable or disable auto-approve",
  description: "Change the permission approval mode",
  category: "Permissions",
  provenance: { type: "core", feature: "builtin-command-adjustments" },
  readOnly: false,
  capabilities: ["permission.mode.write"],
  parse: empty,
  execute: async (context) => {
    await context.approvalMode.open()
    return { status: "completed" }
  },
})
