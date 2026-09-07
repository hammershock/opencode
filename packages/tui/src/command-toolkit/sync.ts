import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type SyncCommandContext = InvocationContext & {
  openSyncSettings: (view: "overview" | "devices") => Promise<"completed" | "cancelled" | "failed">
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

const open = (view: "overview" | "devices") => async (ctx: SyncCommandContext) => {
  const result = await ctx.openSyncSettings(view)
  if (result === "completed") return { status: "completed" as const }
  if (result === "cancelled") return { status: "cancelled" as const }
  return {
    status: "failed" as const,
    code: "sync_settings_failed",
    message: "Sync settings could not be opened",
    retryable: true,
  }
}

export const syncCommands = [
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.settings",
    path: ["sync"],
    title: "Sync settings",
    description: "Manage Session sync",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.configure", "network.open"],
    parse: empty,
    execute: open("overview"),
  }),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.devices",
    path: ["devices"],
    title: "Sync devices",
    description: "Manage devices for the active sync space",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.devices.read", "sync.devices.write"],
    parse: empty,
    execute: open("devices"),
  }),
] as const
