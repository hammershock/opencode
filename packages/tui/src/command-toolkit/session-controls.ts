import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type SessionControlCommandContext = InvocationContext & {
  sessionControls: {
    outputExpansion: (expanded: boolean) => void
    delete: () => Promise<"deleted" | "cancelled">
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

export const sessionControlCommands = [
  defineCommand<void, SessionControlCommandContext>({
    id: "fork.session.expand-output",
    path: ["expand"],
    title: "Expand command output",
    description: "Expand truncated command output in this Session view",
    category: "Session",
    provenance: { type: "core", feature: "builtin-command-adjustments" },
    requires: { session: true },
    capabilities: ["session.view.write"],
    parse: empty,
    execute: async (ctx) => {
      ctx.sessionControls.outputExpansion(true)
      return { status: "completed", message: "Command output expanded" }
    },
  }),
  defineCommand<void, SessionControlCommandContext>({
    id: "fork.session.collapse-output",
    path: ["collapse"],
    title: "Collapse command output",
    description: "Collapse truncated command output in this Session view",
    category: "Session",
    provenance: { type: "core", feature: "builtin-command-adjustments" },
    requires: { session: true },
    capabilities: ["session.view.write"],
    parse: empty,
    execute: async (ctx) => {
      ctx.sessionControls.outputExpansion(false)
      return { status: "completed", message: "Command output collapsed" }
    },
  }),
  defineCommand<void, SessionControlCommandContext>({
    id: "fork.session.delete",
    path: ["delete"],
    title: "Delete session",
    description: "Delete this Session after confirmation",
    category: "Session",
    provenance: { type: "core", feature: "builtin-command-adjustments" },
    requires: { session: true },
    capabilities: ["session.delete"],
    parse: empty,
    execute: async (ctx) => {
      const result = await ctx.sessionControls.delete()
      return result === "cancelled" ? { status: "cancelled" } : { status: "completed", message: "Session deleted" }
    },
  }),
] as const
