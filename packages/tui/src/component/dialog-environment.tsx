import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { createMemo, createSignal, onCleanup } from "solid-js"
import type { EnvironmentMetadata, EnvironmentValues } from "../command-toolkit/environment"

export function createEnvironmentRevealAuthorization() {
  let confirmed = false
  return async (confirm: () => Promise<boolean>) => {
    if (confirmed) return true
    confirmed = await confirm()
    return confirmed
  }
}

const authorizeEnvironmentReveal = createEnvironmentRevealAuthorization()

export function environmentVariableOption(
  variable: EnvironmentMetadata["variables"][number],
  values?: Record<string, string>,
) {
  return {
    title: variable.name,
    description: variable.source,
    footer: variable.overrides.length
      ? `${variable.origin} · overrides ${variable.overrides.join(", ")}`
      : variable.origin,
    value: variable.name,
    ...(values && Object.hasOwn(values, variable.name) ? { revealed: values[variable.name]! } : {}),
  }
}

export function clearEnvironmentValues(revealed: EnvironmentValues | undefined) {
  if (!revealed) return
  Object.keys(revealed.values).forEach((name) => delete revealed.values[name])
}

export function displayEnvironmentValue(value: string) {
  return value.replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("\t", "\\t")
}

export function showEnvironment(
  dialog: DialogContext,
  snapshot: EnvironmentMetadata,
  reveal: () => Promise<EnvironmentValues>,
  onError: (error: unknown) => void,
  initial?: { revealed?: EnvironmentValues; current?: string },
) {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => (
        <EnvironmentDialog dialog={dialog} snapshot={snapshot} reveal={reveal} onError={onError} initial={initial} />
      ),
      resolve,
    )
  })
}

function EnvironmentDialog(props: {
  dialog: DialogContext
  snapshot: EnvironmentMetadata
  reveal: () => Promise<EnvironmentValues>
  onError: (error: unknown) => void
  initial?: { revealed?: EnvironmentValues; current?: string }
}) {
  const { theme } = useTheme()
  const [revealed, setRevealed] = createSignal(props.initial?.revealed)
  const [loading, setLoading] = createSignal(false)
  const options = createMemo(() =>
    props.snapshot.variables.map((variable) => {
      const option = environmentVariableOption(variable, revealed()?.values)
      if (!("revealed" in option) || option.revealed === undefined) return option
      return {
        ...option,
        titleView: (
          <>
            {option.title}
            <span style={{ fg: theme.accent }}>={displayEnvironmentValue(option.revealed)}</span>
          </>
        ),
      }
    }),
  )

  onCleanup(() => clearEnvironmentValues(revealed()))

  async function revealValues(current: string) {
    if (revealed() || loading()) return
    setLoading(true)
    const authorized = await authorizeEnvironmentReveal(async () =>
      Boolean(
        await DialogConfirm.show(
          props.dialog,
          "Reveal environment values?",
          "Values are sensitive and remain visible only until this dialog closes.",
        ),
      ),
    )
    if (!authorized) {
      if (props.dialog.stack.length === 0)
        void showEnvironment(props.dialog, props.snapshot, props.reveal, props.onError, { current })
      setLoading(false)
      return
    }

    try {
      const values = await props.reveal()
      if (props.dialog.stack.length === 0) {
        void showEnvironment(props.dialog, props.snapshot, props.reveal, props.onError, { revealed: values, current })
        return
      }
      setRevealed(values)
    } catch (error) {
      if (props.dialog.stack.length === 0)
        void showEnvironment(props.dialog, props.snapshot, props.reveal, props.onError, { current })
      props.onError(error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogSelect
      title={`Environment · generation ${props.snapshot.generation}`}
      options={options()}
      preserveSelection
      current={props.initial?.current}
      actions={[
        {
          command: "dialog.environment.reveal",
          title: "reveal values",
          disabled: () => loading() || Boolean(revealed()),
          onTrigger: (option) => void revealValues(option.value),
        },
      ]}
      onSelect={() => {}}
    />
  )
}
