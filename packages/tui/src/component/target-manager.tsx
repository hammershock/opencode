import { createResource, createSignal, Match, Switch, untrack } from "solid-js"
import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { DialogConfirm } from "../ui/dialog-confirm"
import { useSDK } from "../context/sdk"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { targetWizard, type TargetDefinition } from "./target-wizard"
import { useTheme } from "../context/theme"

export type TargetHealthState = "checking" | "ready" | "unavailable" | "invalid"

type TargetHealthResult = {
  readonly status: Exclude<TargetHealthState, "checking">
  readonly stage?: string
  readonly message?: string
  readonly checkedAt?: number
  readonly trustedUntil?: number
}

export async function probeTargetHealth(
  targetIDs: readonly string[],
  probe: (targetID: string) => Promise<TargetHealthResult | undefined>,
  publish: (targetID: string, result: TargetHealthResult | undefined) => void,
) {
  await Promise.all(
    targetIDs.map(async (targetID) => {
      const result = await Promise.resolve()
        .then(() => probe(targetID))
        .catch(() => undefined)
      publish(targetID, result)
    }),
  )
}

export function targetProbeGenerations() {
  let next = 0
  const current = new Map<string, number>()
  return {
    begin(targetIDs: readonly string[]) {
      const generation = ++next
      for (const targetID of targetIDs) current.set(targetID, generation)
      return generation
    },
    accept(targetID: string, generation: number) {
      if (current.get(targetID) !== generation) return false
      current.delete(targetID)
      return true
    },
  }
}

export function targetHealthLabel(state: TargetHealthState) {
  return {
    checking: "◐ checking",
    ready: "● ready",
    unavailable: "! unavailable",
    invalid: "! invalid",
  }[state]
}

export function TargetHealth(props: { state: () => TargetHealthState }) {
  const { theme } = useTheme()
  return (
    <Switch>
      <Match when={props.state() === "checking"}>
        <span style={{ fg: theme.warning }}>{targetHealthLabel(props.state())}</span>
      </Match>
      <Match when={props.state() === "ready"}>
        <span style={{ fg: theme.success }}>{targetHealthLabel(props.state())}</span>
      </Match>
      <Match when={props.state() === "unavailable"}>
        <span style={{ fg: theme.error }}>{targetHealthLabel(props.state())}</span>
      </Match>
      <Match when={props.state() === "invalid"}>
        <span style={{ fg: theme.error }}>{targetHealthLabel(props.state())}</span>
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
  const [health, setHealth] = createSignal<Record<string, TargetHealthResult | undefined>>({})
  const [checking, setChecking] = createSignal<ReadonlySet<string>>(new Set())
  const probeGeneration = targetProbeGenerations()

  const refreshHealth = async (force = false) => {
    const definitions = targets()?.targets ?? []
    const now = Date.now()
    const cached = new Map(
      definitions.flatMap((target) => {
        const value = target.health
        if (!value || typeof value.trustedUntil !== "number" || value.trustedUntil <= now) return []
        return [[target.id, value as TargetHealthResult] as const]
      }),
    )
    if (!force && cached.size) {
      setHealth((current) => ({ ...current, ...Object.fromEntries(cached) }))
      setChecking((current) => {
        const next = new Set(current)
        for (const targetID of cached.keys()) next.delete(targetID)
        return next
      })
    }
    const currentHealth = untrack(health)
    const ids = definitions
      .filter((target) => {
        if (force) return true
        const value = cached.get(target.id) ?? currentHealth[target.id]
        return !value?.trustedUntil || value.trustedUntil <= now
      })
      .map((target) => target.id)
    if (!ids.length) return
    const generation = probeGeneration.begin(ids)
    setChecking((current) => new Set([...current, ...ids]))
    await probeTargetHealth(
      ids,
      (targetID) =>
        (force
          ? sdk.client.v2.target.refresh({ targetID }, { throwOnError: true })
          : sdk.client.v2.target.test({ targetID }, { throwOnError: true })
        ).then((result) => result.data as TargetHealthResult),
      (targetID, result) => {
        if (!probeGeneration.accept(targetID, generation)) return
        setHealth((current) => ({ ...current, [targetID]: result }))
        setChecking((current) => {
          const next = new Set(current)
          next.delete(targetID)
          return next
        })
      },
    )
  }

  const state = (targetID: string): TargetHealthState => {
    if (checking().has(targetID)) return "checking"
    const result = health()?.[targetID]
    if (!result) return "unavailable"
    return result.status
  }

  const detail = (targetID: string) => {
    if (checking().has(targetID)) return undefined
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
              .refresh({ targetID: target.id }, { throwOnError: true })
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
              `Remove ${target.name} from this device? Referencing Sessions are preserved as unresolved.`,
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
    void refreshHealth()
    dialog.replace(() => (
      <DialogSelect<TargetDefinition | "add" | "refresh">
        title="Manage targets"
        locked={targets.loading}
        options={[
          { title: "Add target…", value: "add" as const, category: "Actions" },
          { title: "Refresh status", value: "refresh" as const, category: "Actions" },
          ...(targets()?.targets ?? []).map((target) => ({
            title: target.name,
            description: target.connection.host,
            footer: <TargetHealth state={() => state(target.id)} />,
            details: [detail(target.id)].filter((item): item is string => Boolean(item)),
            value: target as TargetDefinition,
            category: "Configured targets",
          })),
        ]}
        onSelect={(option) => {
          if (option.value === "add") return save()
          if (option.value === "refresh") return void refreshHealth(true)
          return manage(option.value)
        }}
      />
    ))
  }

  return {
    targets,
    health,
    state,
    detail,
    refreshHealth,
    refetch: async () => {
      await controls.refetch()
      await refreshHealth()
    },
    open,
  }
}
