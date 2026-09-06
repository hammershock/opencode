import { createResource, Match, Switch } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { targetWizard, type TargetDefinition } from "./target-wizard"
import { useTheme } from "../context/theme"

export type TargetHealthState = "checking" | "ready" | "unavailable" | "invalid"

export function TargetHealth(props: { state: TargetHealthState }) {
  const { theme } = useTheme()
  return (
    <Switch>
      <Match when={props.state === "checking"}>
        <span style={{ fg: theme.warning }}>◐ checking</span>
      </Match>
      <Match when={props.state === "ready"}>
        <span style={{ fg: theme.success }}>● ready</span>
      </Match>
      <Match when={props.state === "unavailable"}>
        <span style={{ fg: theme.error }}>● unavailable</span>
      </Match>
      <Match when={props.state === "invalid"}>
        <span style={{ fg: theme.error }}>● invalid</span>
      </Match>
    </Switch>
  )
}

export function useTargetManager() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [targets, controls] = createResource(async () => {
    const result = await sdk.client.v2.target.list({ throwOnError: true })
    return result.data
  })
  const [health, healthControls] = createResource(
    () => targets()?.targets.map((target) => target.id),
    async (ids) =>
      Object.fromEntries(
        await Promise.all(
          ids.map(async (targetID) => {
            const result = await sdk.client.v2.target.test({ targetID }, { throwOnError: true }).catch(() => undefined)
            return [targetID, result?.data] as const
          }),
        ),
      ),
  )

  const state = (targetID: string): TargetHealthState => {
    if (health.loading) return "checking"
    const result = health()?.[targetID]
    if (!result) return "unavailable"
    return result.status
  }

  const detail = (targetID: string) => {
    const result = health()?.[targetID]
    return result && result.status !== "ready" ? `${result.stage}: ${result.message}` : undefined
  }

  const save = (current?: TargetDefinition) => {
    void (async () => {
      const snapshot = targets()
      if (!snapshot) return
      const input = await targetWizard(dialog, current, {
        inspect: (input) =>
          sdk.client.v2.target.wizard
            .inspect({ input }, { throwOnError: true })
            .then((result) => result.data)
            .catch(() => undefined),
        complete: (input, value, cursor, cwd) =>
          sdk.client.v2.target.wizard
            .complete({ input, value, cursor, cwd }, { throwOnError: true })
            .then((result) => ({ ...result.data, cursor: Number(result.data.cursor) }))
            .catch(() => undefined),
      })
      if (!input) return
      try {
        const result = current
          ? await sdk.client.v2.target.update(
              { targetID: current.id, input, expectedRevision: snapshot.revision },
              { throwOnError: true },
            )
          : await sdk.client.v2.target.create({ input, expectedRevision: snapshot.revision }, { throwOnError: true })
        await controls.refetch()
        const tested = await sdk.client.v2.target.test({ targetID: result.data.target.id }, { throwOnError: true })
        toast.show({
          title: result.data.target.name,
          message:
            tested.data.status === "ready"
              ? "Target verified"
              : `Saved unverified · ${tested.data.stage}: ${tested.data.message}`,
          variant: tested.data.status === "ready" ? "success" : "warning",
        })
        open()
      } catch (error) {
        toast.show({ title: "Target save failed", message: errorMessage(error), variant: "error" })
      }
    })()
  }

  const manage = (target: TargetDefinition) => {
    dialog.replace(() => (
      <DialogSelect
        title={target.name}
        options={[
          { title: "Test connection", value: "test" as const },
          { title: "Edit or rename", value: "edit" as const },
          { title: "Remove target", value: "remove" as const },
        ]}
        onSelect={(option) => {
          if (option.value === "edit") return save(target)
          if (option.value === "test") {
            void sdk.client.v2.target
              .test({ targetID: target.id }, { throwOnError: true })
              .then((result) =>
                toast.show({
                  title: target.name,
                  message:
                    result.data.status === "ready" ? "Target ready" : `${result.data.stage}: ${result.data.message}`,
                  variant: result.data.status === "ready" ? "success" : "warning",
                }),
              )
              .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
            return
          }
          void (async () => {
            const confirmed = await DialogConfirm.show(
              dialog,
              "Remove target",
              `Remove ${target.name} globally? Referencing Sessions are preserved as unresolved.`,
            )
            if (!confirmed || !targets()) return
            await sdk.client.v2.target.remove(
              { targetID: target.id, expectedRevision: targets()!.revision },
              { throwOnError: true },
            )
            await controls.refetch()
            open()
          })().catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        }}
      />
    ))
  }

  function open(mode: "manage" | "add" = "manage") {
    if (mode === "add") return save()
    dialog.replace(() => (
      <DialogSelect
        title="Manage targets"
        locked={targets.loading}
        options={[
          { title: "Add target…", value: undefined, category: "Actions" },
          ...(targets()?.targets ?? []).map((target) => ({
            title: target.name,
            description: target.connection.host,
            footer: <TargetHealth state={state(target.id)} />,
            details: [detail(target.id)].filter((item): item is string => Boolean(item)),
            value: target as TargetDefinition,
            category: "Configured targets",
          })),
        ]}
        onSelect={(option) => (option.value ? manage(option.value) : save())}
      />
    ))
  }

  return {
    targets,
    health,
    state,
    detail,
    refetch: async () => {
      await controls.refetch()
      await healthControls.refetch()
    },
    open,
  }
}
