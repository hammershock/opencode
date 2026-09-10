import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type EnvironmentMetadata = {
  enabled: boolean
  generation: number
  variables: ReadonlyArray<{ name: string; origin: string; source?: string; overrides: ReadonlyArray<string> }>
}

export type EnvironmentValues = { generation: number; values: Record<string, string> }
export type EnvironmentInitResult =
  | { status: "completed"; template: "created" | "existing"; generation: number }
  | { status: "cancelled" | "failed"; template: "created" | "existing" }

export type EnvironmentCommandContext = InvocationContext & {
  environment: {
    list: () => Promise<EnvironmentMetadata>
    reload: () => Promise<EnvironmentMetadata>
    reveal: () => Promise<EnvironmentValues>
    init: () => Promise<EnvironmentInitResult>
  }
  presentEnvironment: (snapshot: EnvironmentMetadata, reveal: () => Promise<EnvironmentValues>) => Promise<void>
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
      const result = await ctx.environment.init()
      if (result.status !== "completed") {
        if (result.status === "cancelled") return { status: "cancelled", message: "Environment was not reloaded" }
        return {
          status: "failed",
          code: "agent_failed",
          message: "Environment was not reloaded",
          retryable: true,
        }
      }
      return {
        status: "completed",
        message: `${result.template === "created" ? "Created" : "Kept"} .env and loaded generation ${result.generation}`,
      }
    },
  }),
] as const
