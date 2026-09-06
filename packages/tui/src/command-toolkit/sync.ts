import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type SyncStatus = {
  enabled: boolean
  provider?: string
  namespaceID?: string
  deviceID?: string
  locked?: boolean
  cursors: Readonly<Record<string, number>>
  outbox: number
  lastSuccessAt?: number
  error?: string
}

export type SyncCommandContext = InvocationContext & {
  sync: {
    status: () => Promise<SyncStatus>
    now: () => Promise<void>
    enable: (enabled: boolean) => Promise<void>
    exportKey: () => Promise<string>
    importKey: (recovery: string) => Promise<void>
  }
  openSyncSetup: () => Promise<"completed" | "cancelled" | "failed">
  presentSyncStatus: (status: SyncStatus) => Promise<void>
  presentSensitiveRecoveryKey: (key: string) => Promise<void>
  promptSensitiveRecoveryKey: () => Promise<string | undefined>
  confirmAndResetSync: () => Promise<"completed" | "cancelled" | "failed">
  openDevices: () => Promise<"completed" | "cancelled" | "failed">
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

const outcome = (value: "completed" | "cancelled" | "failed", code: string) => {
  if (value === "completed") return { status: "completed" as const }
  if (value === "cancelled") return { status: "cancelled" as const }
  return { status: "failed" as const, code, message: "Cloud sync operation failed", retryable: true }
}

const toggle = (action: "enable" | "disable") =>
  defineCommand<void, SyncCommandContext>({
    id: `fork.sync.${action}`,
    path: ["sync", action],
    title: `${action === "enable" ? "Enable" : "Disable"} cloud sync`,
    description: `${action === "enable" ? "Start" : "Stop"} device background sync without deleting data`,
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.configure"],
    parse: empty,
    execute: async (ctx) => {
      await ctx.sync.enable(action === "enable")
      return { status: "completed" }
    },
  })

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
    execute: async (ctx) => outcome(await ctx.openSyncSetup(), "sync_setup_failed"),
  }),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.status",
    path: ["sync", "status"],
    title: "Cloud sync status",
    description: "Show cursors, outbox and redacted diagnostics",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.status.read"],
    parse: empty,
    execute: async (ctx) => {
      await ctx.presentSyncStatus(await ctx.sync.status())
      return { status: "completed" }
    },
  }),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.now",
    path: ["sync", "now"],
    title: "Sync now",
    description: "Upload and pull immediately",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.execute", "network.open"],
    parse: empty,
    execute: async (ctx) => {
      await ctx.sync.now()
      return { status: "completed" }
    },
  }),
  toggle("enable"),
  toggle("disable"),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.export-key",
    path: ["sync", "export-key"],
    title: "Export recovery key",
    description: "Show the recovery key in a sensitive temporary dialog",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["credential.read"],
    parse: empty,
    execute: async (ctx) => {
      await ctx.presentSensitiveRecoveryKey(await ctx.sync.exportKey())
      return { status: "completed" }
    },
  }),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.import-key",
    path: ["sync", "import-key"],
    title: "Import recovery key",
    description: "Import a recovery key through a sensitive dialog",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["credential.write"],
    parse: empty,
    execute: async (ctx) => {
      const key = await ctx.promptSensitiveRecoveryKey()
      if (!key) return { status: "cancelled" }
      await ctx.sync.importKey(key)
      return { status: "completed" }
    },
  }),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.reset",
    path: ["sync", "reset"],
    title: "Reset sync space",
    description: "Permanently replace the encrypted namespace after explicit confirmation",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.configure", "credential.write", "network.open", "remote.delete"],
    parse: empty,
    execute: async (ctx) => outcome(await ctx.confirmAndResetSync(), "sync_reset_failed"),
  }),
  defineCommand<void, SyncCommandContext>({
    id: "fork.sync.devices",
    path: ["devices"],
    title: "Sync devices",
    description: "Manage device names, revocation and portable target bindings",
    category: "Sync",
    provenance: { type: "core", feature: "cloud-sync" },
    requires: {},
    capabilities: ["sync.devices.read", "sync.devices.write"],
    parse: empty,
    execute: async (ctx) => outcome(await ctx.openDevices(), "sync_devices_failed"),
  }),
] as const
