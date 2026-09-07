import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog, type DialogContext } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { targetWizard, type TargetDefinition } from "./target-wizard"
import type { SessionLocationRebindingResolution } from "@opencode-ai/sdk/v2"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useTuiPaths } from "../context/runtime"
import { promptLocationDirectory, targetWizardServices } from "./location-directory-workflow"

export type TargetResolution = SessionLocationRebindingResolution
export type UnresolvedTargetResolution = Exclude<TargetResolution, { status: "resolved" }>
type SDK = ReturnType<typeof useSDK>
type Destination =
  | { target: { type: "local" }; name: "local"; definition?: undefined }
  | { target: { type: "rexd"; targetID: string }; name: string; definition: TargetDefinition }

export function portableBindingRequest(
  resolution: Extract<TargetResolution, { status: "unbound_portable_target" }>,
  targetID: string,
  bindingRevision: string,
) {
  return {
    portableTargetLabel: resolution.portableTargetLabel,
    targetID,
    expectedRevision: bindingRevision,
    expectedSessionIDs: [...resolution.referencedSessionIDs],
  }
}

export function portableTargetIsUnbound(bindings: Readonly<Record<string, string>>, label: string) {
  return bindings[label] === undefined
}

function select<T>(dialog: DialogContext, title: string, options: DialogSelectOption<T>[]) {
  return new Promise<T | undefined>((resolve) =>
    dialog.replace(
      () => <DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value)} />,
      () => resolve(undefined),
    ),
  )
}

async function selectDestination(dialog: DialogContext, sdk: SDK) {
  const registry = await sdk.client.v2.target.list({ throwOnError: true })
  return select<Destination>(dialog, "Select execution target", [
    { title: "Local machine", value: { target: { type: "local" }, name: "local" }, category: "Targets" },
    ...registry.data.targets.map((item) => ({
      title: item.name,
      description: item.connection.host,
      value: {
        target: { type: "rexd" as const, targetID: item.id },
        name: item.name,
        definition: item as TargetDefinition,
      },
      category: "Targets",
    })),
  ])
}

async function sessionRevision(sdk: SDK, sessionID: string) {
  const current = await sdk.client.v2.session.get({ sessionID }, { throwOnError: true })
  return Number(current.data.data.locationRevision ?? 0)
}

async function rebindOne(input: {
  dialog: DialogContext
  sdk: SDK
  sessionID: string
  currentDirectory: string
  localHome: string
  expectedRevision?: number
  confirm: boolean
}) {
  const destination = await selectDestination(input.dialog, input.sdk)
  if (!destination) return
  const directory = await promptLocationDirectory({
    dialog: input.dialog,
    sdk: input.sdk,
    target:
      destination.target.type === "local"
        ? { type: "local" }
        : { type: "rexd", targetID: destination.target.targetID, name: destination.name },
    definition: destination.definition,
    current: input.currentDirectory,
    localHome: input.localHome,
  })
  if (!directory) return
  if (
    input.confirm &&
    !(await DialogConfirm.show(
      input.dialog,
      "Force rebind this Session?",
      "Experimental and not recommended. Existing conversation and tool history may describe a different workspace.",
    ))
  )
    return
  return input.sdk.client.v2.sessionLocation.rebind(
    {
      sessionID: input.sessionID,
      sessionLocationRebindingRebindInput: {
        expectedRevision: input.expectedRevision ?? (await sessionRevision(input.sdk, input.sessionID)),
        destination: {
          target: destination.target,
          directory,
          ...(destination.target.type === "rexd" ? { lastKnownTargetName: destination.name } : {}),
        },
      },
    },
    { throwOnError: true },
  )
}

export async function forceRebindSession(input: {
  dialog: DialogContext
  sdk: SDK
  sessionID: string
  expectedRevision: number
  currentDirectory?: string
  localHome?: string
}) {
  return rebindOne({
    ...input,
    currentDirectory: input.currentDirectory ?? input.localHome ?? "/",
    localHome: input.localHome ?? "/",
    confirm: true,
  })
}

export function resolutionDescription(resolution: TargetResolution) {
  if (resolution.status === "missing_local_target")
    return `Target removed · ${resolution.lastKnownTargetName ?? resolution.missingTargetID}`
  if (resolution.status === "unbound_portable_target")
    return `Target not configured on this device · ${resolution.portableTargetLabel}`
  if (resolution.status === "target_unavailable") return `${resolution.stage} · ${resolution.message}`
  if (resolution.status === "resolution_failed") return resolution.message
  return "Ready"
}

export function DialogSessionLocationRecovery(props: { sessionID: string; resolution: UnresolvedTargetResolution }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const paths = useTuiPaths()
  const resolution = props.resolution
  const services = targetWizardServices(sdk)

  const readOnly = () => {
    route.navigate({
      type: "session",
      sessionID: props.sessionID,
      accessMode: "read-only",
      resolution: resolution.status,
    })
    dialog.clear()
  }

  const reopen = async () => {
    const result = await sdk.client.v2.sessionLocation.resolve({ sessionID: props.sessionID }, { throwOnError: true })
    const next = result.data
    if (next.status === "resolved") {
      route.navigate({ type: "session", sessionID: props.sessionID, accessMode: "read-write" })
      dialog.clear()
      return
    }
    dialog.replace(() => <DialogSessionLocationRecovery sessionID={props.sessionID} resolution={next} />)
  }

  const restoreMissing = async () => {
    if (resolution.status !== "missing_local_target") return
    const registry = await sdk.client.v2.target.list({ throwOnError: true })
    const draft: TargetDefinition = {
      id: resolution.missingTargetID,
      name: resolution.lastKnownTargetName ?? "restored-target",
      transport: "ssh",
      connection: { type: "ssh-config", host: resolution.lastKnownTargetName ?? "" },
      workspaceRoots: ["/"],
    }
    const input = await targetWizard(dialog, draft, services)
    if (!input) return
    await sdk.client.v2.target.restore(
      {
        targetID: resolution.missingTargetID,
        input,
        referencedSessionIDs: [...resolution.referencedSessionIDs],
        expectedRevision: registry.data.revision,
      },
      { throwOnError: true },
    )
    await reopen()
  }

  const bind = async (targetID: string, bindingRevision: string) => {
    if (resolution.status !== "unbound_portable_target") return
    await sdk.client.v2.targetBinding.bind(portableBindingRequest(resolution, targetID, bindingRevision), {
      throwOnError: true,
    })
    await reopen()
  }

  const bindPortable = async () => {
    if (resolution.status !== "unbound_portable_target") return
    const [targets, bindings] = await Promise.all([
      sdk.client.v2.target.list({ throwOnError: true }),
      sdk.client.v2.targetBinding.list({ throwOnError: true }),
    ])
    // A resolution dialog may be stale. Ordinary recovery never overwrites a
    // binding that appeared after it was opened; the user must review the new
    // resolution or use the separately gated force-rebind workflow.
    if (!portableTargetIsUnbound(bindings.data.bindings, resolution.portableTargetLabel)) return reopen()
    const choice = await select<string>(dialog, `Bind ${resolution.portableTargetLabel}`, [
      ...targets.data.targets.map((target) => ({
        title: target.name,
        description: target.connection.host,
        value: target.id,
        category: "Configured targets",
      })),
      { title: "Create target…", value: "__create__", category: "Actions" },
    ])
    if (!choice) return
    if (choice !== "__create__") return bind(choice, bindings.data.revision)
    const createdInput = await targetWizard(dialog, undefined, services)
    if (!createdInput) return
    const latest = await sdk.client.v2.target.list({ throwOnError: true })
    const created = await sdk.client.v2.target.create(
      { input: createdInput, expectedRevision: latest.data.revision },
      { throwOnError: true },
    )
    await bind(created.data.target.id, bindings.data.revision)
  }

  const editUnavailable = async () => {
    if (resolution.status !== "target_unavailable") return
    const registry = await sdk.client.v2.target.list({ throwOnError: true })
    const current = registry.data.targets.find((item) => item.id === resolution.target.id)
    if (!current) return reopen()
    const input = await targetWizard(dialog, current as TargetDefinition, services)
    if (!input) return
    await sdk.client.v2.target.update(
      { targetID: current.id, input, expectedRevision: registry.data.revision },
      { throwOnError: true },
    )
    await reopen()
  }

  const recoveryRebind = async () => {
    const current =
      resolution.status === "unbound_portable_target"
        ? resolution.directory
        : "location" in resolution
          ? resolution.location.directory
          : paths.home
    await rebindOne({
      dialog,
      sdk,
      sessionID: props.sessionID,
      currentDirectory: current,
      localHome: paths.home,
      confirm: true,
    })
    await reopen()
  }

  const options: DialogSelectOption<"read" | "restore" | "bind" | "retry" | "edit" | "rebind">[] = [
    {
      title: "Open read-only",
      description: "History remains available; execution and file access are disabled",
      value: "read",
    },
    ...(resolution.status === "missing_local_target"
      ? [
          {
            title: "Restore missing target…",
            description: `Restore its identity for ${resolution.referencedSessionIDs.length} Sessions`,
            value: "restore" as const,
          },
          {
            title: "Rebind this Session…",
            description: "Experimental · changes only this Session",
            value: "rebind" as const,
          },
        ]
      : []),
    ...(resolution.status === "unbound_portable_target"
      ? [
          {
            title: "Bind target on this device…",
            description: `${resolution.referencedSessionIDs.length} Sessions will be validated before binding`,
            value: "bind" as const,
          },
          {
            title: "Rebind this Session…",
            description: "Experimental · changes only this Session",
            value: "rebind" as const,
          },
        ]
      : []),
    ...(resolution.status === "target_unavailable"
      ? [
          { title: "Retry validation", description: resolutionDescription(resolution), value: "retry" as const },
          {
            title: "Edit target configuration…",
            description: `Repair ${resolution.target.name} without creating a duplicate`,
            value: "edit" as const,
          },
        ]
      : []),
    ...(resolution.status === "resolution_failed"
      ? [{ title: "Retry validation", description: resolution.message, value: "retry" as const }]
      : []),
  ]

  return (
    <DialogSelect
      title="Session target unavailable"
      options={options}
      onSelect={(option) => {
        if (option.value === "read") return readOnly()
        const operation =
          option.value === "restore"
            ? restoreMissing()
            : option.value === "bind"
              ? bindPortable()
              : option.value === "edit"
                ? editUnavailable()
                : option.value === "rebind"
                  ? recoveryRebind()
                  : reopen()
        void operation.catch((cause) =>
          toast.show({ title: "Session target recovery failed", message: errorMessage(cause), variant: "error" }),
        )
      }}
    />
  )
}
