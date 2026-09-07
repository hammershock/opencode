import type { DialogContext } from "../ui/dialog"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogAlert } from "../ui/dialog-alert"

export type SyncState = "off" | "idle" | "syncing" | "locked" | "attention"
export type SyncInterval = 30 | 60 | 300

export type SyncSpace = {
  id: string
  name: string
  supported: boolean
  protocol: string
  encryption: "off" | "encrypted"
  updatedAt?: string
  devices: number
  sessions: number
  membership: "available" | "joined" | "active"
  state: SyncState
  detail?: string
}

export type SyncDevice = {
  id: string
  name: string
  current: boolean
  state: "ready" | "attention" | "revoked"
  detail?: string
}

export type SyncSettingsViewModel = {
  account:
    | {
        state: "disconnected"
        oauth: {
          state: "idle" | "opening" | "waiting" | "manual" | "attention"
          authorizationURL?: string
          detail?: string
        }
      }
    | {
        state: "connected"
        maskedAccount: string
      }
  enabled: boolean
  interval: SyncInterval
  state: SyncState
  detail?: string
  activeSpace?: SyncSpace
  spaces: readonly SyncSpace[]
  devices: readonly SyncDevice[]
}

export type SyncDiff = {
  localOnly: number
  cloudOnly: number
  shared: number
  conflicts: number
}

export type SyncSettingsActions = {
  connect: () => Promise<void>
  copy: (value: string) => Promise<void>
  submitOAuthCode: (code: string) => Promise<void>
  syncNow: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setInterval: (interval: SyncInterval) => Promise<void>
  discoverSpaces: () => Promise<void>
  createSpace: (input: { name: string; encryption: "off" | "encrypted" }) => Promise<{ recoveryKey?: string }>
  prepareEnter: (input: { spaceID: string; recoveryKey?: string }) => Promise<SyncDiff>
  enterSpace: (spaceID: string) => Promise<void>
  switchSpace: (spaceID: string) => Promise<void>
  leaveSpace: (spaceID: string) => Promise<void>
  deleteSpace: (spaceID: string) => Promise<void>
  logout: () => Promise<void>
  removeFromDevice: () => Promise<void>
  revokeDevice: (deviceID: string) => Promise<void>
}

type Row = { title: string; description?: string; status?: string; disabled?: boolean; details?: string[] }

export function syncStatus(state: SyncState) {
  if (state === "idle") return "● idle"
  if (state === "syncing") return "◐ syncing"
  if (state === "locked") return "! locked"
  if (state === "attention") return "! attention"
  return "● off"
}

export function maskRecoveryKey(value: string) {
  return value.length <= 4 ? "••••" : `•••• ${value.slice(-4)}`
}

export function buildSyncOverviewRows(model: SyncSettingsViewModel): Row[] {
  if (model.account.state === "disconnected") {
    const oauth = model.account.oauth
    return [
      { title: "Connect Baidu Netdisk", status: oauth.state === "idle" ? undefined : oauthStatus(oauth.state) },
      ...(oauth.authorizationURL ? [{ title: "Copy authorization URL", description: oauth.authorizationURL }] : []),
      ...(oauth.state === "waiting" || oauth.state === "manual" || oauth.state === "attention"
        ? [{ title: "Enter authorization code" }]
        : []),
    ]
  }
  return [
    { title: model.account.maskedAccount, description: "Baidu Netdisk", status: "● connected" },
    {
      title: model.activeSpace?.name ?? "No active space",
      description: model.activeSpace ? spaceSummary(model.activeSpace) : "Create or enter a space",
      status: model.activeSpace ? syncStatus(model.activeSpace.state) : "! attention",
    },
    { title: "Sync now", status: syncStatus(model.state) },
    { title: "Auto sync", status: model.enabled ? "● on" : "● off" },
    { title: "Interval", status: intervalLabel(model.interval) },
    { title: "Spaces", status: String(model.spaces.length) },
    { title: "Devices", status: String(model.devices.length) },
    { title: "Remove from this device" },
    { title: "Log out" },
  ]
}

export function buildSpaceRows(spaces: readonly SyncSpace[]): Row[] {
  return spaces.map((space) => ({
    title: space.name,
    description: spaceSummary(space),
    status: space.supported ? syncStatus(space.state) : "! unsupported",
    disabled: !space.supported,
    details: [
      `Protocol ${space.protocol} · Encryption ${space.encryption === "off" ? "Off" : "On"}`,
      ...(space.updatedAt ? [`Updated ${space.updatedAt}`] : []),
      ...(space.detail ? [space.detail] : []),
    ],
  }))
}

export function buildDeviceRows(devices: readonly SyncDevice[]): Row[] {
  return devices.map((device) => ({
    title: device.name,
    description: device.current ? "This device" : undefined,
    status: deviceStatus(device.state),
    disabled: device.current || device.state === "revoked",
    details: device.detail ? [device.detail] : undefined,
  }))
}

export function showSyncSettings(
  dialog: DialogContext,
  model: () => SyncSettingsViewModel,
  actions: SyncSettingsActions,
) {
  const open = () => showSyncSettings(dialog, model, actions)
  const rows = buildSyncOverviewRows(model())
  const values = model().account.state === "disconnected" ? disconnectedValues(model()) : connectedValues()
  dialog.replace(() => (
    <DialogSelect
      title="Sync settings"
      options={rows.map((row, index) => ({
        ...row,
        footer: row.status,
        value: values[index]!,
      }))}
      footer={model().detail ? <text>{model().detail}</text> : undefined}
      onSelect={(option) => void selectOverview(option.value, dialog, model, actions, open)}
    />
  ))
}

async function selectOverview(
  value: string,
  dialog: DialogContext,
  model: () => SyncSettingsViewModel,
  actions: SyncSettingsActions,
  open: () => void,
) {
  const current = model()
  if (value === "connect") await actions.connect()
  if (value === "copy-url" && current.account.state === "disconnected" && current.account.oauth.authorizationURL)
    await actions.copy(current.account.oauth.authorizationURL)
  if (value === "oauth-code") {
    const code = await DialogPrompt.show(dialog, "Authorization code", { placeholder: "Paste code" })
    if (code?.trim()) await actions.submitOAuthCode(code.trim())
  }
  if (value === "sync") await actions.syncNow()
  if (value === "enabled") await actions.setEnabled(!current.enabled)
  if (value === "interval") return showIntervals(dialog, current.interval, actions, open)
  if (value === "spaces") {
    await actions.discoverSpaces()
    return showSpaces(dialog, model, actions)
  }
  if (value === "devices") return showDevices(dialog, model, actions)
  if (value === "remove") {
    const confirm = await DialogConfirm.show(
      dialog,
      "Remove sync from this device?",
      "Remove local sync settings and keys. Cloud data and other devices remain unchanged.",
    )
    if (confirm) await actions.removeFromDevice()
  }
  if (value === "logout") {
    const confirm = await DialogConfirm.show(
      dialog,
      "Log out of Baidu Netdisk?",
      "Disconnect this device. Sync spaces and cloud data remain unchanged.",
    )
    if (confirm) await actions.logout()
  }
  open()
}

function showIntervals(dialog: DialogContext, current: SyncInterval, actions: SyncSettingsActions, open: () => void) {
  const intervals = [30, 60, 300] as const
  dialog.replace(() => (
    <DialogSelect
      title="Sync interval"
      current={current}
      options={intervals.map((value) => ({ title: intervalLabel(value), value }))}
      onSelect={(option) => void actions.setInterval(option.value).then(open)}
    />
  ))
}

function showSpaces(dialog: DialogContext, model: () => SyncSettingsViewModel, actions: SyncSettingsActions) {
  const open = () => showSpaces(dialog, model, actions)
  const spaces = model().spaces
  const rows = buildSpaceRows(spaces)
  dialog.replace(() => (
    <DialogSelect
      title="Sync spaces"
      options={[
        { title: "Create space", value: "create", category: "Actions" },
        ...spaces.map((space, index) => ({
          ...rows[index]!,
          footer: rows[index]!.status,
          value: space.id,
          category: "Spaces",
        })),
      ]}
      onSelect={(option) => {
        if (option.value === "create") return void createSpace(dialog, actions, open)
        const space = model().spaces.find((item) => item.id === option.value)
        if (space?.supported) void showSpaceActions(dialog, space, actions, open)
      }}
    />
  ))
}

async function createSpace(dialog: DialogContext, actions: SyncSettingsActions, open: () => void) {
  const name = await DialogPrompt.show(dialog, "Space name", { placeholder: "My sessions" })
  if (!name?.trim()) return open()
  dialog.replace(() => (
    <DialogSelect<"off" | "encrypted">
      title="Encryption"
      current="off"
      options={[
        {
          title: "Off",
          description: "Integrity protected; content is visible to the storage provider",
          value: "off" as const,
        },
        { title: "On", description: "Requires the recovery key on every device", value: "encrypted" as const },
      ]}
      onSelect={(option) =>
        void actions.createSpace({ name: name.trim(), encryption: option.value }).then(async (result) => {
          if (!result.recoveryKey) return open()
          showRecoveryKey(dialog, result.recoveryKey, actions, open)
        })
      }
    />
  ))
}

function showRecoveryKey(dialog: DialogContext, key: string, actions: SyncSettingsActions, open: () => void) {
  dialog.replace(() => (
    <DialogSelect
      title="Recovery key"
      options={[
        { title: maskRecoveryKey(key), description: "Keep this key outside OpenCode", value: "summary" },
        { title: "Copy recovery key", value: "copy" },
      ]}
      onSelect={(option) => {
        if (option.value === "copy") void actions.copy(key).then(open)
      }}
    />
  ))
}

function showSpaceActions(dialog: DialogContext, space: SyncSpace, actions: SyncSettingsActions, open: () => void) {
  const options: DialogSelectOption<string>[] = []
  if (space.membership === "available") options.push({ title: "Enter space", value: "enter" })
  if (space.membership === "joined") options.push({ title: "Switch to this space", value: "switch" })
  if (space.membership !== "available") options.push({ title: "Leave on this device", value: "leave" })
  options.push({ title: "Delete space globally", value: "delete" })
  dialog.replace(() => (
    <DialogSelect
      title={space.name}
      options={options}
      onSelect={(option) => void runSpaceAction(dialog, space, option.value, actions, open)}
    />
  ))
}

async function runSpaceAction(
  dialog: DialogContext,
  space: SyncSpace,
  value: string,
  actions: SyncSettingsActions,
  open: () => void,
) {
  if (value === "enter") {
    const recoveryKey =
      space.encryption === "encrypted"
        ? await DialogPrompt.show(dialog, "Recovery key", { placeholder: "Paste recovery key" })
        : undefined
    if (space.encryption === "encrypted" && !recoveryKey?.trim()) return open()
    const diff = await actions.prepareEnter({ spaceID: space.id, recoveryKey: recoveryKey?.trim() })
    const confirmed = await DialogConfirm.show(dialog, `Enter ${space.name}?`, diffSummary(diff))
    if (confirmed) await actions.enterSpace(space.id)
  }
  if (value === "switch") {
    const confirmed = await DialogConfirm.show(
      dialog,
      `Switch to ${space.name}?`,
      "Stop the current space and activate this space on this device.",
    )
    if (confirmed) await actions.switchSpace(space.id)
  }
  if (value === "leave") {
    const confirmed = await DialogConfirm.show(
      dialog,
      `Leave ${space.name}?`,
      "Remove membership and keys from this device. Cloud data remains.",
    )
    if (confirmed) await actions.leaveSpace(space.id)
  }
  if (value === "delete") {
    const confirmed = await DialogConfirm.show(
      dialog,
      `Delete ${space.name} globally?`,
      "Permanently delete this sync space for all devices. It cannot be restored.",
    )
    if (confirmed) await actions.deleteSpace(space.id)
  }
  open()
}

function showDevices(dialog: DialogContext, model: () => SyncSettingsViewModel, actions: SyncSettingsActions) {
  const open = () => showDevices(dialog, model, actions)
  const devices = model().devices
  const rows = buildDeviceRows(devices)
  dialog.replace(() => (
    <DialogSelect
      title="Devices"
      options={devices.map((device, index) => ({
        ...rows[index]!,
        footer: rows[index]!.status,
        value: device,
      }))}
      footer={<text>Current device cannot revoke itself.</text>}
      onSelect={(option) =>
        option.value.current || option.value.state === "revoked"
          ? undefined
          : void DialogConfirm.show(
              dialog,
              `Revoke ${option.value.name}?`,
              "Remove this device from the active space. Existing local data is not remotely erased.",
            ).then(async (confirmed) => {
              if (confirmed) await actions.revokeDevice(option.value.id)
              open()
            })
      }
    />
  ))
}

export async function showAssignUnassignedSessions(
  dialog: DialogContext,
  input: { count: number; decide: (assignAll: boolean) => Promise<void> },
) {
  if (input.count === 0) return input.decide(false)
  await new Promise<void>((resolve) =>
    dialog.replace(
      () => (
        <DialogSelect
          title="Add unassigned Sessions?"
          footer={<text>Add all {input.count} unassigned Sessions to the active sync space?</text>}
          options={[
            { title: "Yes, add all", value: true },
            { title: "No", value: false },
          ]}
          onSelect={(option) => void input.decide(option.value).then(resolve)}
        />
      ),
      resolve,
    ),
  )
}

function disconnectedValues(model: SyncSettingsViewModel) {
  if (model.account.state !== "disconnected") return []
  return [
    "connect",
    ...(model.account.oauth.authorizationURL ? ["copy-url"] : []),
    ...(model.account.oauth.state === "waiting" ||
    model.account.oauth.state === "manual" ||
    model.account.oauth.state === "attention"
      ? ["oauth-code"]
      : []),
  ]
}

function connectedValues() {
  return ["account", "active", "sync", "enabled", "interval", "spaces", "devices", "remove", "logout"]
}

function oauthStatus(state: Extract<SyncSettingsViewModel["account"], { state: "disconnected" }>["oauth"]["state"]) {
  if (state === "opening") return "◐ opening"
  if (state === "waiting") return "◐ waiting"
  if (state === "manual" || state === "attention") return "! attention"
  return "● ready"
}

function intervalLabel(value: SyncInterval) {
  if (value === 30) return "30 sec"
  if (value === 60) return "1 min"
  return "5 min"
}

function spaceSummary(space: SyncSpace) {
  return `Encryption ${space.encryption === "off" ? "Off" : "On"} · ${space.devices} devices · ${space.sessions} Sessions`
}

function diffSummary(diff: SyncDiff) {
  return `Local only ${diff.localOnly} · Cloud only ${diff.cloudOnly} · Shared ${diff.shared} · Conflicts ${diff.conflicts}`
}

function deviceStatus(state: SyncDevice["state"]) {
  if (state === "ready") return "● ready"
  if (state === "revoked") return "× revoked"
  return "! attention"
}
