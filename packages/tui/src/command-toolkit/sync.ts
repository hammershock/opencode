import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type SyncCommandContext = InvocationContext & {
  openSyncSetup: () => Promise<"completed" | "cancelled" | "failed">
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

export const syncCommands = [
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.setup",
    path: ["sync", "setup"],
    title: "Set up cloud sync",
    description: "Configure an encrypted Baidu Netdisk sync namespace",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.configure", "credential.write", "network.open"],
    parse: empty,
    execute: async (ctx) => {
      const result = await ctx.openSyncSetup()
      if (result === "completed") return { status: "completed" }
      if (result === "cancelled") return { status: "cancelled" }
      return { status: "failed", code: "sync_setup_failed", message: "Cloud sync setup failed", retryable: true }
    },
  }),
] as const
