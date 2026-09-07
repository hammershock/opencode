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
  devices?: number
  sessions?: number
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
  remote: "idle" | "checking" | "ready" | "unavailable"
  detail?: string
  activeSpace?: SyncSpace
  spaces: readonly SyncSpace[]
  devices: readonly SyncDevice[]
  bindings: readonly SyncBinding[]
  pending: number
  unassigned: readonly string[]
}

export type SyncDiff = {
  localOnly?: number
  cloudOnly?: number
  shared?: number
  conflicts?: number
}

export type SyncSettingsActions = {
  connect: (mode?: "connect" | "switch") => Promise<void>
  useManualOAuth: () => Promise<void>
  copy: (value: string) => Promise<void>
  submitOAuthCode: (code: string) => Promise<void>
  syncNow: () => Promise<void>
  setEnabled: (enabled: boolean) => Promise<void>
  setInterval: (interval: SyncInterval) => Promise<void>
  discoverSpaces: () => Promise<void>
  createSpace: (input: { name: string; encryption: "off" | "encrypted" }) => Promise<{
    recoveryKey?: string
    spaceID: string
    activation: "switched" | "blocked"
  }>
  prepareEnter: (input: { spaceID: string; recoveryKey?: string }) => Promise<SyncDiff>
  enterSpace: (input: { spaceID: string; recoveryKey?: string }) => Promise<{ status: "switched" | "blocked" }>
  switchSpace: (input: { spaceID: string; force: boolean }) => Promise<{ status: "switched" | "blocked" | "failed" }>
  leaveSpace: (spaceID: string) => Promise<void>
  deleteSpace: (spaceID: string) => Promise<void>
  logout: () => Promise<void>
  removeFromDevice: () => Promise<void>
  revokeDevice: (deviceID: string) => Promise<void>
  exportRecoveryKey: () => Promise<string>
  renameDevice: (deviceID: string, name: string) => Promise<void>
  updateBinding: (label: string, targetID: string, sessionIDs: readonly string[]) => Promise<void>
  removeBinding: (label: string, sessionIDs: readonly string[]) => Promise<void>
  targets: () => Promise<readonly { id: string; name: string; description?: string }[]>
  assignUnassigned: (sessionIDs: readonly string[]) => Promise<void>
  promptUnassigned: (force: boolean) => Promise<void>
  onError: (error: unknown) => void
}

type Row = { title: string; description?: string; status?: string; disabled?: boolean; details?: string[] }

export function syncStatus(state: SyncState) {
  if (state === "idle") return "● idle"
  if (state === "syncing") return "◐ syncing"
  if (state === "locked") return "! locked"
  if (state === "attention") return "! attention"
  return "● off"
}

export function syncRemoteStatus(state: SyncSettingsViewModel["remote"]) {
  if (state === "checking") return "◐ checking"
  if (state === "unavailable") return "! unavailable"
  if (state === "ready") return "● ready"
  return "○ not checked"
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
      ...(oauth.state === "waiting" || oauth.state === "attention" ? [{ title: "Use manual code" }] : []),
      ...(oauth.state === "manual" ? [{ title: "Enter authorization code" }] : []),
    ]
  }
  return [
    { title: model.account.maskedAccount, description: "Baidu Netdisk", status: "● connected" },
    {
      title:
        model.remote === "unavailable"
          ? "Retry cloud status"
          : model.remote === "idle"
            ? "Check cloud status"
            : "Cloud status",
      status: syncRemoteStatus(model.remote),
    },
    {
      title: model.activeSpace?.name ?? "No active space",
      description: model.activeSpace ? spaceSummary(model.activeSpace) : "Create or enter a space",
      status: model.activeSpace ? syncStatus(model.activeSpace.state) : "! attention",
    },
    {
      title: "Sync now",
      description: model.activeSpace ? undefined : "Select a space first",
      status: model.activeSpace ? syncStatus(model.state) : "! unavailable",
    },
    { title: "Auto sync", status: model.enabled ? "● on" : "● off" },
    { title: "Interval", status: intervalLabel(model.interval) },
    { title: "Spaces", status: String(model.spaces.length) },
    { title: "Devices", status: String(model.devices.length) },
    ...(model.activeSpace?.encryption === "encrypted" ? [{ title: "Recovery key" }] : []),
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
    const values = () =>
      model().account.state === "disconnected" ? disconnectedValues(model()) : connectedValues(model())
    return (
      <DialogSelect
        title="Sync settings"
        options={rows().map((row, index) => ({
          ...row,
          footer: row.status,
          value: values()[index]!,
        }))}
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
  // This dialog is reactive, so a completed background refresh must not
  // replace it. Replacing here would resurrect a panel the user closed while
  // the provider request was still in flight.
  if (value === "refresh") return actions.discoverSpaces()
  if (value === "active") {
    await actions.discoverSpaces()
    return showSpaces(dialog, model, actions)
  }
  if (value === "sync") {
    if (!current.activeSpace) {
      await actions.discoverSpaces()
      return showSpaces(dialog, model, actions)
    }
    await actions.syncNow()
    await showAssignUnassignedSessions(dialog, {
      sessionIDs: model().unassigned,
      decide: async (assign, sessionIDs) => {
        if (!assign) return
        await actions.assignUnassigned(sessionIDs)
        await actions.syncNow()
      },
    })
  }
  if (value === "enabled") await actions.setEnabled(!current.enabled)
  if (value === "interval") return showIntervals(dialog, current.interval, actions, open)
  if (value === "spaces") {
    await actions.discoverSpaces()
    return showSpaces(dialog, model, actions)
  }
  if (value === "devices") return showSyncDevices(dialog, model, actions)
  if (value === "recovery") return showRecoveryKey(dialog, await actions.exportRecoveryKey(), actions, open)
  if (value === "remove") {
    const confirm = await DialogConfirm.show(
      dialog,
      "Remove sync from this device?",
      "Remove local sync settings and keys. Local Sessions remain unassigned; cloud data and other devices remain unchanged.",
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

function showAccount(dialog: DialogContext, actions: SyncSettingsActions, open: () => void) {
  dialog.replace(() => (
    <DialogSelect
      title="Baidu Netdisk account"
      options={[{ title: "Switch account", value: "switch" }]}
      onSelect={() => void actions.connect("switch").then(open).catch(actions.onError)}
    />
  ))
}

function showIntervals(dialog: DialogContext, current: SyncInterval, actions: SyncSettingsActions, open: () => void) {
  const intervals = [30, 60, 300] as const
  dialog.replace(() => (
    <DialogSelect
      title="Sync interval"
      current={current}
      options={intervals.map((value) => ({ title: intervalLabel(value), value }))}
      onSelect={(option) => void actions.setInterval(option.value).then(open).catch(actions.onError)}
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
        if (option.value === "create") return void createSpace(dialog, actions, open).catch(actions.onError)
        const space = model().spaces.find((item) => item.id === option.value)
        if (space?.supported) showSpaceActions(dialog, space, actions, open)
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
        void actions
          .createSpace({ name: name.trim(), encryption: option.value })
          .then(async (result) => {
            const finish = async () => {
              const activated = await finishActivation(dialog, name.trim(), result.spaceID, result.activation, actions)
              if (activated) await actions.promptUnassigned(false)
              open()
            }
            if (result.recoveryKey) return showRecoveryKey(dialog, result.recoveryKey, actions, finish)
            await finish()
          })
          .catch(actions.onError)
      }
    />
  ))
}

function showRecoveryKey(
  dialog: DialogContext,
  key: string,
  actions: SyncSettingsActions,
  next: () => void | Promise<void>,
) {
  let finished = false
  const finish = () => {
    if (finished) return
    finished = true
    void Promise.resolve(next()).catch(actions.onError)
  }
  dialog.replace(
    () => (
      <DialogSelect
        title="Recovery key"
        options={[
          { title: maskRecoveryKey(key), description: "Keep this key outside OpenCode", value: "summary" },
          { title: "Copy recovery key", value: "copy" },
        ]}
        onSelect={(option) => {
          if (option.value === "copy") void actions.copy(key).then(finish)
        }}
      />
    ),
    finish,
  )
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
      onSelect={(option) => void runSpaceAction(dialog, space, option.value, actions, open).catch(actions.onError)}
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
    if (confirmed) {
      const result = await actions.enterSpace({ spaceID: space.id, recoveryKey: recoveryKey?.trim() })
      if (await finishActivation(dialog, space.name, space.id, result.status, actions)) {
        await actions.promptUnassigned(false)
      }
    }
  }
  if (value === "switch") {
    if (space.state === "syncing") return open()
    const confirmed = await DialogConfirm.show(
      dialog,
      `Switch to ${space.name}?`,
      "Stop the current space and activate this space on this device. Membership and pending data remain.",
    )
    if (!confirmed) return open()
    const result = await actions.switchSpace({ spaceID: space.id, force: false })
    if (result.status === "blocked") {
      const force = await DialogConfirm.show(
        dialog,
        `Force switch to ${space.name}?`,
        "Pending data stays with the old space and is not uploaded to the new space.",
      )
      if (force) await actions.switchSpace({ spaceID: space.id, force: true })
    }
  }
  if (value === "leave") {
    const confirmed = await DialogConfirm.show(
      dialog,
      `Leave ${space.name} on this device?`,
      "Remove this space's local membership and key. Local Sessions become unassigned; cloud data remains.",
    )
    if (confirmed) await actions.leaveSpace(space.id)
  }
  if (value === "delete") {
    const confirmed = await DialogConfirm.show(
      dialog,
      `Delete ${space.name} globally?`,
      "Permanently delete this sync space for all devices. Local Sessions remain unassigned; the space cannot be restored.",
    )
    if (confirmed) await actions.deleteSpace(space.id)
  }
  open()
}

async function finishActivation(
  dialog: DialogContext,
  name: string,
  spaceID: string,
  status: "switched" | "blocked",
  actions: SyncSettingsActions,
) {
  if (status === "switched") return true
  const force = await DialogConfirm.show(
    dialog,
    `Force switch to ${name}?`,
    "Pending data stays with the old space and is not uploaded to the new space.",
  )
  if (!force) return false
  return (await actions.switchSpace({ spaceID, force: true })).status === "switched"
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
        footer={<text>{syncRemoteStatus(model().remote)}</text>}
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
          "Remove this device from the active space. Existing local data is not remotely erased.",
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
        details: binding.sessionIDs.length === 0 ? ["No active-space Sessions use this label"] : undefined,
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

export async function showAssignUnassignedSessions(
  dialog: DialogContext,
  input: {
    sessionIDs: readonly string[]
    decide: (assignAll: boolean, sessionIDs: readonly string[]) => Promise<void>
  },
) {
  if (input.sessionIDs.length === 0) return input.decide(false, input.sessionIDs)
  let decided = false
  await new Promise<void>((resolve, reject) =>
    dialog.replace(
      () => (
        <DialogSelect
          title="Add unassigned Sessions?"
          footer={<text>Add all {input.sessionIDs.length} unassigned Sessions to the active sync space?</text>}
          options={[
            { title: "Yes, add all", value: true },
            { title: "No", value: false },
          ]}
          onSelect={(option) => {
            decided = true
            void input.decide(option.value, input.sessionIDs).then(resolve, reject)
          }}
        />
      ),
      () => {
        if (decided) return resolve()
        decided = true
        void input.decide(false, input.sessionIDs).then(resolve, reject)
      },
    ),
  )
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

function connectedValues(model: SyncSettingsViewModel) {
  return [
    "account",
    "refresh",
    "active",
    "sync",
    "enabled",
    "interval",
    "spaces",
    "devices",
    ...(model.activeSpace?.encryption === "encrypted" ? ["recovery"] : []),
    "remove",
    "logout",
  ]
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
  return [
    `Encryption ${space.encryption === "off" ? "Off" : "On"}`,
    ...(space.devices === undefined ? [] : [`${space.devices} devices`]),
    ...(space.sessions === undefined ? [] : [`${space.sessions} Sessions`]),
  ].join(" · ")
}

function diffSummary(diff: SyncDiff) {
  return (
    [
      ...(diff.localOnly === undefined ? [] : [`Local only ${diff.localOnly}`]),
      ...(diff.cloudOnly === undefined ? [] : [`Cloud only ${diff.cloudOnly}`]),
      ...(diff.shared === undefined ? [] : [`Shared ${diff.shared}`]),
      ...(diff.conflicts === undefined ? [] : [`Conflicts ${diff.conflicts}`]),
    ].join(" · ") || "Review this space before entering"
  )
}

function deviceStatus(state: SyncDevice["state"]) {
  if (state === "ready") return "● ready"
  if (state === "revoked") return "× revoked"
  return "! attention"
}
