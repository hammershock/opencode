import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { useSDK } from "../context/sdk"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { targetWizard } from "./target-wizard"
import type { SessionLocationRebindingResolution } from "@opencode-ai/sdk/v2"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import type { DialogContext } from "../ui/dialog"

export type TargetResolution = SessionLocationRebindingResolution
export type UnresolvedTargetResolution = Exclude<TargetResolution, { status: "resolved" }>

export async function forceRebindSession(input: {
  dialog: DialogContext
  sdk: ReturnType<typeof useSDK>
  sessionID: string
  expectedRevision: number
}) {
  const registry = await input.sdk.client.v2.target.list({ throwOnError: true })
  type Destination = { type: "local" } | { type: "rexd"; targetID: string }
  const options: DialogSelectOption<Destination>[] = [
    { title: "Local machine", value: { type: "local" }, category: "Targets" },
    ...registry.data.targets.map((item) => ({
      title: item.name,
      description: item.connection.host,
      value: { type: "rexd" as const, targetID: item.id },
      category: "Targets",
    })),
  ]
  const target = await new Promise<Destination | undefined>((resolve) =>
    input.dialog.replace(() => (
      <DialogSelect
        title="Force rebind Location · Experimental"
        options={options}
        onSelect={(option) => resolve(option.value)}
      />
    )),
  )
  if (!target) return
  const directory = await DialogPrompt.show(input.dialog, "Absolute working directory")
  if (!directory?.trim()) return
  const confirmed = await DialogConfirm.show(
    input.dialog,
    "Force rebind this Session?",
    "Experimental and not recommended. Existing conversation and tool history may describe a different workspace.",
  )
  if (!confirmed) return
  return input.sdk.client.v2.sessionLocation.rebind(
    {
      sessionID: input.sessionID,
      sessionLocationRebindingRebindInput: {
        expectedRevision: input.expectedRevision,
        destination: { target, directory: directory.trim() },
      },
    },
    { throwOnError: true },
  )
}

export function resolutionDescription(resolution: TargetResolution) {
  if (resolution.status === "missing_local_target")
    return `Target removed · ${resolution.lastKnownTargetName ?? resolution.missingTargetID}`
  if (resolution.status === "unbound_portable_target")
    return `Target not configured on this device · ${resolution.portableTargetLabel}`
  if (resolution.status === "target_unavailable") return `${resolution.stage} · ${resolution.message}`
  return "Ready"
}

export function DialogSessionLocationRecovery(props: { sessionID: string; resolution: UnresolvedTargetResolution }) {
  const dialog = useDialog()
  const sdk = useSDK()
  const route = useRoute()
  const toast = useToast()
  const resolution = props.resolution

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
      route.navigate({ type: "session", sessionID: props.sessionID })
      dialog.clear()
      return
    }
    dialog.replace(() => <DialogSessionLocationRecovery sessionID={props.sessionID} resolution={next} />)
  }

  const restoreMissing = async () => {
    if (resolution.status !== "missing_local_target") return
    const input = await targetWizard(dialog, {
      id: resolution.missingTargetID,
      name: resolution.lastKnownTargetName ?? "restored-target",
      transport: "ssh",
      connection: { type: "ssh-config", host: resolution.lastKnownTargetName ?? "" },
      workspaceRoots: ["/"],
    })
    if (!input) return
    const registry = await sdk.client.v2.target.list({ throwOnError: true })
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

  const bindPortable = async () => {
    if (resolution.status !== "unbound_portable_target") return
    const targets = await sdk.client.v2.target.list({ throwOnError: true })
    dialog.replace(() => (
      <DialogSelect
        title={`Bind ${resolution.portableTargetLabel}`}
        options={targets.data.targets.map((target) => ({
          title: target.name,
          description: target.connection.host,
          value: target.id,
        }))}
        onSelect={(option) => {
          void sdk.client.v2.targetBinding
            .bind(
              {
                portableTargetLabel: resolution.portableTargetLabel,
                targetID: option.value,
                expectedRevision: targets.data.revision,
                expectedSessionIDs: [...resolution.referencedSessionIDs],
              },
              { throwOnError: true },
            )
            .then(reopen)
            .catch((cause) =>
              toast.show({ title: "Target binding failed", message: errorMessage(cause), variant: "error" }),
            )
        }}
      />
    ))
  }

  return (
    <DialogSelect
      title="Session target unavailable"
      options={[
        {
          title: "Open read-only",
          description: "History remains available; execution and file access are disabled",
          value: "read" as const,
        },
        ...(resolution.status === "missing_local_target"
          ? [
              {
                title: "Configure the missing target…",
                description: `${resolution.referencedSessionIDs.length} Sessions will be reviewed`,
                value: "restore" as const,
              },
            ]
          : []),
        ...(resolution.status === "unbound_portable_target"
          ? [
              {
                title: "Bind to a configured target…",
                description: `${resolution.referencedSessionIDs.length} Sessions will be affected`,
                value: "bind" as const,
              },
            ]
          : []),
        ...(resolution.status === "target_unavailable"
          ? [
              {
                title: "Retry validation",
                description: resolutionDescription(resolution),
                value: "retry" as const,
              },
            ]
          : []),
      ]}
      onSelect={(option) => {
        if (option.value === "read") return readOnly()
        const operation =
          option.value === "restore" ? restoreMissing() : option.value === "bind" ? bindPortable() : reopen()
        void operation.catch((cause) =>
          toast.show({ title: "Session target recovery failed", message: errorMessage(cause), variant: "error" }),
        )
      }}
    />
  )
}
