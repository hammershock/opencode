import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type EnvironmentMetadata = {
  enabled: boolean
  generation: number
  variables: ReadonlyArray<{ name: string; origin: string; source?: string; overrides: ReadonlyArray<string> }>
}

export type EnvironmentValues = { generation: number; values: Record<string, string> }

export type EnvironmentCommandContext = InvocationContext & {
  environment: {
    list: () => Promise<EnvironmentMetadata>
    reload: () => Promise<EnvironmentMetadata>
    reveal: () => Promise<EnvironmentValues>
    ensureTemplate: () => Promise<"created" | "existing">
  }
  presentEnvironment: (snapshot: EnvironmentMetadata, reveal: () => Promise<EnvironmentValues>) => Promise<void>
  invokeAgent: (prompt: string) => Promise<"completed" | "cancelled" | "failed">
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

export const environmentCommands = [
  defineCommand<void, EnvironmentCommandContext>({
    id: "fork.environment.list",
    path: ["env", "list"],
    title: "List environment",
    description: "Show names, origins, and generation without exposing values",
    category: "Environment",
    provenance: { type: "core", feature: "location-environment" },
    requires: { location: true },
    capabilities: ["environment.metadata.read"],
    parse: empty,
    execute: async (ctx) => {
      await ctx.presentEnvironment(await ctx.environment.list(), ctx.environment.reveal)
      return { status: "completed" }
    },
  }),
  defineCommand<void, EnvironmentCommandContext>({
    id: "fork.environment.reload",
    path: ["env", "reload"],
    title: "Reload environment",
    description: "Atomically reload target-side .env sources",
    category: "Environment",
    provenance: { type: "core", feature: "location-environment" },
    requires: { location: true },
    capabilities: ["environment.reload"],
    parse: empty,
    execute: async (ctx) => {
      const snapshot = await ctx.environment.reload()
      await ctx.presentEnvironment(snapshot, ctx.environment.reveal)
      return { status: "completed", message: `Environment generation ${snapshot.generation} loaded` }
    },
  }),
  defineCommand<void, EnvironmentCommandContext>({
    id: "fork.environment.init",
    path: ["env", "init"],
    title: "Initialize environment",
    description: "Ensure .env, ask the Agent to edit it, then reload",
    category: "Environment",
    provenance: { type: "core", feature: "location-environment" },
    requires: { session: true, location: true },
    capabilities: ["workspace.write", "agent.invoke", "environment.reload"],
    parse: empty,
    execute: async (ctx) => {
      const template = await ctx.environment.ensureTemplate()
      const result = await ctx.invokeAgent(
        "Review the project .env file, add only the environment variables required by this workspace, and do not expose secret values in chat.",
      )
      if (result === "cancelled") return { status: "cancelled", message: "Environment was not reloaded" }
      if (result === "failed") {
        return { status: "failed", code: "agent_failed", message: "Environment was not reloaded", retryable: true }
      }
      const snapshot = await ctx.environment.reload()
      return {
        status: "completed",
        message: `${template === "created" ? "Created" : "Kept"} .env and loaded generation ${snapshot.generation}`,
      }
    },
  }),
] as const

export async function revealEnvironment(input: {
  confirm: () => Promise<boolean>
  reveal: () => Promise<EnvironmentValues>
  present: (values: EnvironmentValues) => Promise<void>
}) {
  if (!(await input.confirm())) return false
  const revealed = await input.reveal()
  try {
    await input.present(revealed)
  } finally {
    Object.keys(revealed.values).forEach((name) => delete revealed.values[name])
  }
  return true
}
