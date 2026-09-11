import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"
import { useTheme } from "../context/theme"
import { useClipboard } from "../context/clipboard"
import { useToast } from "../ui/toast"
import { createMemo, createSignal, For, onCleanup } from "solid-js"
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

export function environmentEntry(name: string, value: string) {
  return `${name}=${value}`
}

export function environmentInspectionFrame(name: string, value: string, width: number, offset: number) {
  const characters = [
    ...[...name].map((text) => ({ text, revealed: false })),
    ...[...`=${displayEnvironmentValue(value)}`].map((text) => ({ text, revealed: true })),
    ...[..."   "].map((text) => ({ text, revealed: false })),
  ]
  const start = ((offset % characters.length) + characters.length) % characters.length
  return [...characters.slice(start), ...characters.slice(0, start)].reduce(
    (result, character) => {
      if (result.done) return result
      const nextWidth = result.width + Bun.stringWidth(character.text)
      if (nextWidth > width) return { ...result, done: true }
      const previous = result.segments.at(-1)
      if (previous?.revealed === character.revealed) {
        previous.text += character.text
        return { ...result, width: nextWidth }
      }
      result.segments.push({ ...character })
      return { ...result, width: nextWidth }
    },
    { segments: [] as { text: string; revealed: boolean }[], width: 0, done: false },
  ).segments
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
  const clipboard = useClipboard()
  const toast = useToast()
  const [revealed, setRevealed] = createSignal(props.initial?.revealed)
  const [loading, setLoading] = createSignal(false)
  const options = createMemo(() =>
    props.snapshot.variables.map((variable) => {
      const option = environmentVariableOption(variable, revealed()?.values)
      if (!("revealed" in option) || option.revealed === undefined) return option
      const value = option.revealed
      return {
        ...option,
        inspectTitle: true,
        inspectionTitle: `${option.title}=${displayEnvironmentValue(value)}`,
        inspectionView: (offset: number, width: number) => (
          <>
            <For each={environmentInspectionFrame(option.title, value, width, offset)}>
              {(segment) => <span style={{ fg: segment.revealed ? theme.accent : undefined }}>{segment.text}</span>}
            </For>
          </>
        ),
        titleView: () => (
          <>
            {option.title}
            <span style={{ fg: theme.accent }}>={displayEnvironmentValue(value)}</span>
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

  async function copyEntry(name: string) {
    const values = revealed()?.values
    if (!values || !Object.hasOwn(values, name)) return
    if (!clipboard.write) {
      toast.show({ message: "Clipboard is unavailable", variant: "error" })
      return
    }
    await clipboard.write(environmentEntry(name, values[name]!)).then(
      () => toast.show({ message: "Copied environment entry to clipboard", variant: "success" }),
      () => toast.show({ message: "Failed to copy environment entry", variant: "error" }),
    )
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
        ...(revealed()
          ? [
              {
                command: "dialog.environment.copy",
                title: "copy KEY=VALUE",
                onTrigger: (option: { value: string }) => void copyEntry(option.value),
              },
            ]
          : []),
      ]}
      onSelect={() => {}}
    />
  )
}
