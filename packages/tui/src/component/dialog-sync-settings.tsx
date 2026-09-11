import type { DialogContext } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"

export type SyncState = "off" | "idle" | "syncing" | "locked" | "attention"
export type SyncInterval = 30 | 60 | 300
export type SyncCloudState =
  | "unknown"
  | "checking"
  | "ready"
  | "uninitialized"
  | "upgrade-required"
  | "replaced"
  | "incompatible"
  | "unavailable"

export type SyncDevice = {
  id: string
  name: string
  current: boolean
  state: "ready" | "attention" | "revoked"
  detail?: string
}

export type SyncBinding = { label: string; targetID?: string; sessionIDs: readonly string[] }

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
  cloud: SyncCloudState
  detail?: string
  devices: readonly SyncDevice[]
  bindings: readonly SyncBinding[]
  pending: number
}

export type SyncSettingsActions = {
  connect: (mode?: "connect" | "switch") => Promise<void>
  useManualOAuth: () => Promise<void>
  copy: (value: string) => Promise<void>
  submitOAuthCode: (code: string) => Promise<void>
  checkCloud: () => Promise<void>
  initializeCloud: () => Promise<void>
  clearCloud: () => Promise<void>
  syncNow: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setInterval: (interval: SyncInterval) => Promise<void>
  logout: () => Promise<void>
  revokeDevice: (deviceID: string) => Promise<void>
  renameDevice: (deviceID: string, name: string) => Promise<void>
  updateBinding: (label: string, targetID: string, sessionIDs: readonly string[]) => Promise<void>
  removeBinding: (label: string, sessionIDs: readonly string[]) => Promise<void>
  targets: () => Promise<readonly { id: string; name: string; description?: string }[]>
  onError: (error: unknown) => void
}

export type BaiduApplication = { type: "credentials"; appKey: string; secretKey: string } | { type: "legacy" }

type Row = { title: string; description?: string; status?: string; disabled?: boolean; details?: string[] }

export function syncStatus(state: SyncState) {
  if (state === "idle") return "● idle"
  if (state === "syncing") return "◐ syncing"
  if (state === "locked") return "! locked"
  if (state === "attention") return "! attention"
  return "● off"
}

export function syncCloudStatus(state: SyncCloudState) {
  if (state === "checking") return "◐ checking"
  if (state === "ready") return "● ready"
  if (state === "uninitialized") return "○ not initialized"
  if (state === "upgrade-required") return "! upgrade required"
  if (state === "replaced") return "! cloud data replaced"
  if (state === "incompatible") return "! incompatible"
  if (state === "unavailable") return "! unavailable"
  return "○ not checked"
}

export function buildSyncOverviewRows(model: SyncSettingsViewModel): Row[] {
  if (model.account.state === "disconnected") {
    const oauth = model.account.oauth
    return [
      { title: "Connect Baidu Netdisk", status: oauth.state === "idle" ? undefined : oauthStatus(oauth.state) },
      ...(oauth.authorizationURL ? [{ title: "Copy authorization URL", description: oauth.authorizationURL }] : []),
      ...(oauth.state === "waiting" || oauth.state === "attention" ? [{ title: "Use manual code" }] : []),
      ...(oauth.state === "manual" ? [{ title: "Enter authorization code" }] : []),
    ]
  }
  return [
    { title: model.account.maskedAccount, description: "Baidu Netdisk", status: "● connected" },
    { title: "Automatic sync", status: model.enabled ? "● on" : "● off" },
    { title: "Sync now", status: syncStatus(model.state) },
    { title: "Interval", status: intervalLabel(model.interval) },
    { title: "Devices", status: String(model.devices.filter((item) => item.state !== "revoked").length) },
    {
      title:
        model.cloud === "unavailable"
          ? "Retry cloud status"
          : model.cloud === "unknown"
            ? "Check cloud status"
            : "Cloud status",
      status: syncCloudStatus(model.cloud),
    },
    { title: "Clear cloud sync data", description: "Permanently remove all cloud Session history" },
    { title: "Log out" },
  ]
}

export function buildDeviceRows(devices: readonly SyncDevice[]): Row[] {
  return devices.map((device) => ({
    title: device.name,
    description: device.current ? "This device" : undefined,
    status: deviceStatus(device.state),
    disabled: device.state === "revoked",
    details: device.detail ? [device.detail] : undefined,
  }))
}

export function showSyncSettings(
  dialog: DialogContext,
  model: () => SyncSettingsViewModel,
  actions: SyncSettingsActions,
) {
  const open = () => showSyncSettings(dialog, model, actions)
  const Content = () => {
    const rows = () => buildSyncOverviewRows(model())
    const values = () => (model().account.state === "disconnected" ? disconnectedValues(model()) : connectedValues())
    return (
      <DialogSelect
        title="Sync settings"
        options={rows().map((row, index) => ({ ...row, footer: row.status, value: values()[index]! }))}
        footer={model().detail ? <text>{model().detail}</text> : undefined}
        onSelect={(option) => void selectOverview(option.value, dialog, model, actions, open).catch(actions.onError)}
      />
    )
  }
  dialog.replace(() => <Content />)
}

async function selectOverview(
  value: string,
  dialog: DialogContext,
  model: () => SyncSettingsViewModel,
  actions: SyncSettingsActions,
  open: () => void,
) {
  const current = model()
  if (value === "connect") await actions.connect("connect")
  if (value === "copy-url" && current.account.state === "disconnected" && current.account.oauth.authorizationURL)
    await actions.copy(current.account.oauth.authorizationURL)
  if (value === "oauth-manual") await actions.useManualOAuth()
  if (value === "oauth-code") {
    const code = await DialogPrompt.show(dialog, "Authorization code", { placeholder: "Paste code" })
    if (code?.trim()) await actions.submitOAuthCode(code.trim())
  }
  if (value === "account") return showAccount(dialog, actions, open)
  if (value === "enabled") await actions.setEnabled(!current.enabled)
  if (value === "sync") await actions.syncNow()
  if (value === "interval") return showIntervals(dialog, current.interval, actions, open)
  if (value === "devices") return showSyncDevices(dialog, model, actions)
  if (value === "cloud") return actions.checkCloud()
  if (value === "clear") {
    const first = await DialogConfirm.show(
      dialog,
      "Clear cloud sync data?",
      "All Session history in the OpenCode Baidu sync directory will be permanently deleted. Local Sessions remain.",
    )
    if (!first) return open()
    const second = await DialogConfirm.show(
      dialog,
      "This cannot be undone",
      "Clear all cloud Session data and turn off automatic sync on this device?",
      undefined,
      { confirmLabel: "Clear cloud sync data", destructive: true },
    )
    if (!second) return open()
    await actions.clearCloud()
    return
  }
  if (value === "logout") {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Log out of Baidu Netdisk?",
      "Automatic sync will turn off. Local Sessions and queued changes remain.",
    )
    if (!confirmed) return open()
    await actions.logout()
    return
  }
}

export function showPostLoginSyncChoice(dialog: DialogContext) {
  return new Promise<"enable-now" | "enable" | "disabled" | undefined>((resolve) =>
    dialog.replace(
      () => (
        <DialogSelect
          title="Enable automatic sync?"
          options={[
            { title: "Enable and sync now", value: "enable-now" as const },
            { title: "Enable", value: "enable" as const },
            { title: "Keep disabled", value: "disabled" as const },
          ]}
          onSelect={(option) => resolve(option.value)}
        />
      ),
      () => resolve(undefined),
    ),
  )
}

export function promptBaiduApplication(dialog: DialogContext) {
  return new Promise<BaiduApplication | undefined>((resolve) =>
    dialog.replace(
      () => (
        <DialogSelect
          title="Connect your Baidu application"
          options={[
            {
              title: "Enter AppKey and SecretKey",
              description: "Use credentials from your own Baidu Open Platform application",
              value: "credentials" as const,
            },
            {
              title: "Import previous OpenCode credential",
              description: "Copy and verify the legacy Keychain or PasswordVault entry; keep the original",
              value: "legacy" as const,
            },
          ]}
          onSelect={async (option) => {
            if (option.value === "legacy") return resolve({ type: "legacy" })
            const appKey = await DialogPrompt.show(dialog, "Baidu AppKey", { placeholder: "AppKey" })
            if (!appKey?.trim()) return resolve(undefined)
            const secretKey = await DialogPrompt.show(dialog, "Baidu SecretKey", { placeholder: "SecretKey" })
            if (!secretKey?.trim()) return resolve(undefined)
            resolve({ type: "credentials", appKey: appKey.trim(), secretKey: secretKey.trim() })
          }}
        />
      ),
      () => resolve(undefined),
    ),
  )
}

export function confirmInitializeCloud(dialog: DialogContext) {
  return DialogConfirm.show(
    dialog,
    "Initialize cloud sync?",
    "Create the OpenCode Session sync directory in Baidu Netdisk and start synchronizing.",
    undefined,
    { confirmLabel: "Initialize and sync" },
  )
}

export function confirmJoinCloud(dialog: DialogContext) {
  return DialogConfirm.show(
    dialog,
    "Use existing cloud sync?",
    "Download existing cloud Sessions and add this device's local Sessions to the same history.",
    undefined,
    { confirmLabel: "Use cloud and sync" },
  )
}

function showAccount(dialog: DialogContext, actions: SyncSettingsActions, open: () => void) {
  const content = () => (
    <DialogSelect
      title="Baidu Netdisk account"
      options={[{ title: "Switch account", value: "switch" }]}
      onSelect={() =>
        void actions
          .connect("switch")
          .then(() => {
            if (dialog.isCurrent(content)) open()
          })
          .catch(actions.onError)
      }
    />
  )
  dialog.replace(content)
}

function showIntervals(dialog: DialogContext, current: SyncInterval, actions: SyncSettingsActions, open: () => void) {
  const intervals = [30, 60, 300] as const
  const content = () => (
    <DialogSelect
      title="Sync interval"
      current={current}
      options={intervals.map((value) => ({ title: intervalLabel(value), value }))}
      onSelect={(option) =>
        void actions
          .setInterval(option.value)
          .then(() => {
            if (dialog.isCurrent(content)) open()
          })
          .catch(actions.onError)
      }
    />
  )
  dialog.replace(content)
}

export function showSyncDevices(
  dialog: DialogContext,
  model: () => SyncSettingsViewModel,
  actions: SyncSettingsActions,
) {
  const open = () => showSyncDevices(dialog, model, actions)
  const Content = () => {
    const rows = () => buildDeviceRows(model().devices)
    return (
      <DialogSelect<{ type: "device"; device: SyncDevice } | { type: "bindings" }>
        title="Devices"
        options={[
          ...model().devices.map((device, index) => ({
            ...rows()[index]!,
            footer: rows()[index]!.status,
            value: { type: "device" as const, device },
            category: "Devices",
          })),
          {
            title: "Target bindings",
            footer: String(model().bindings.length),
            value: { type: "bindings" as const },
            category: "Location",
          },
        ]}
        footer={<text>{syncCloudStatus(model().cloud)}</text>}
        onSelect={(option) => {
          if (option.value.type === "bindings") return showBindings(dialog, model, actions, open)
          showDeviceActions(dialog, option.value.device, actions, open)
        }}
      />
    )
  }
  dialog.replace(() => <Content />)
}

function showDeviceActions(dialog: DialogContext, device: SyncDevice, actions: SyncSettingsActions, open: () => void) {
  dialog.replace(() => (
    <DialogSelect
      title={device.name}
      options={[
        { title: "Rename", value: "rename" as const },
        ...(!device.current ? [{ title: "Revoke", value: "revoke" as const }] : []),
      ]}
      onSelect={(option) => {
        if (option.value === "rename")
          return void DialogPrompt.show(dialog, "Device name", { value: device.name })
            .then(async (name) => {
              if (name?.trim()) await actions.renameDevice(device.id, name.trim())
              open()
            })
            .catch(actions.onError)
        void DialogConfirm.show(
          dialog,
          `Revoke ${device.name}?`,
          "This device will no longer block deletion cleanup. Its local data is not remotely erased.",
        )
          .then(async (confirmed) => {
            if (confirmed) await actions.revokeDevice(device.id)
            open()
          })
          .catch(actions.onError)
      }}
    />
  ))
}

function showBindings(
  dialog: DialogContext,
  model: () => SyncSettingsViewModel,
  actions: SyncSettingsActions,
  back: () => void,
) {
  const open = () => showBindings(dialog, model, actions, back)
  dialog.replace(() => (
    <DialogSelect
      title="Target bindings"
      options={model().bindings.map((binding) => ({
        title: binding.label,
        description: binding.targetID ?? "Unbound",
        value: binding,
        category: "Bindings",
        disabled: binding.sessionIDs.length === 0,
        details: binding.sessionIDs.length === 0 ? ["No synced Sessions use this label"] : undefined,
      }))}
      onSelect={(option) => void editBinding(dialog, option.value, actions, open).catch(actions.onError)}
    />
  ))
}

async function editBinding(
  dialog: DialogContext,
  binding: SyncBinding,
  actions: SyncSettingsActions,
  open: () => void,
) {
  const targets = await actions.targets()
  const choice = await new Promise<{ type: "bind"; targetID: string } | { type: "unbind" } | undefined>((resolve) =>
    dialog.replace(
      () => (
        <DialogSelect<{ type: "bind"; targetID: string } | { type: "unbind" }>
          title={`Bind ${binding.label}`}
          options={[
            ...targets.map((target) => ({
              title: target.name,
              description: target.description,
              value: { type: "bind" as const, targetID: target.id },
            })),
            ...(binding.targetID ? [{ title: "Unbind", value: { type: "unbind" as const } }] : []),
          ]}
          onSelect={(option) => resolve(option.value)}
        />
      ),
      () => resolve(undefined),
    ),
  )
  if (!choice) return open()
  if (choice.type === "unbind") {
    const confirmed = await DialogConfirm.show(
      dialog,
      `Unbind ${binding.label}?`,
      "Affected Sessions become unresolved until this label is bound again.",
    )
    if (!confirmed) return open()
    await actions.removeBinding(binding.label, binding.sessionIDs)
    return open()
  }
  await actions.updateBinding(binding.label, choice.targetID, binding.sessionIDs)
  open()
}

function disconnectedValues(model: SyncSettingsViewModel) {
  if (model.account.state !== "disconnected") return []
  return [
    "connect",
    ...(model.account.oauth.authorizationURL ? ["copy-url"] : []),
    ...(model.account.oauth.state === "waiting" || model.account.oauth.state === "attention" ? ["oauth-manual"] : []),
    ...(model.account.oauth.state === "manual" ? ["oauth-code"] : []),
  ]
}

function connectedValues() {
  return ["account", "enabled", "sync", "interval", "devices", "cloud", "clear", "logout"]
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

function deviceStatus(state: SyncDevice["state"]) {
  if (state === "ready") return "● ready"
  if (state === "revoked") return "× revoked"
  return "! attention"
}
