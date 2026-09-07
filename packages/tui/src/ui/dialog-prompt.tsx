import { TextareaRenderable, TextAttributes } from "@opentui/core"
import { useTheme } from "../context/theme"
import { useDialog, type DialogContext } from "./dialog"
import { For, Show, createEffect, createMemo, createSignal, onMount, type JSX } from "solid-js"
import { Spinner } from "../component/spinner"
import { useTuiConfig } from "../config"
import { useBindings, useCommandShortcut } from "../keymap"

export type DialogPromptProps = {
  title: string
  description?: () => JSX.Element
  placeholder?: string
  value?: string
  busy?: boolean
  busyText?: string
  complete?: (
    value: string,
    cursor: number,
  ) => Promise<
    | {
        value: string
        cursor: number
        candidates: string[]
      }
    | undefined
  >
  onConfirm?: (value: string) => void
  onCancel?: () => void
}

export function promptCandidateWindow(candidates: string[], selected: number, limit = 8) {
  const start = Math.max(0, Math.min(selected - limit + 1, candidates.length - limit))
  return { start, items: candidates.slice(start, start + limit) }
}

export function DialogPrompt(props: DialogPromptProps) {
  const dialog = useDialog()
  const { theme } = useTheme()
  const tuiConfig = useTuiConfig()
  const submitShortcut = useCommandShortcut("dialog.prompt.submit")
  const [textareaTarget, setTextareaTarget] = createSignal<TextareaRenderable>()
  const [completing, setCompleting] = createSignal(false)
  const [candidates, setCandidates] = createSignal<string[]>([])
  const [selected, setSelected] = createSignal(0)
  const visibleCandidates = createMemo(() => promptCandidateWindow(candidates(), selected()))
  let textarea: TextareaRenderable
  let completedValue: string | undefined

  function confirm() {
    if (props.busy) return
    if (candidates().length) return apply(candidates()[selected()]!)
    props.onConfirm?.(textarea.plainText)
  }

  function apply(value: string) {
    completedValue = value
    textarea.setText(value)
    textarea.cursorOffset = Bun.stringWidth(value)
    setCandidates([])
    setSelected(0)
  }

  async function complete() {
    if (!props.complete || completing()) return
    setCompleting(true)
    const result = await props.complete(textarea.plainText, textarea.cursorOffset).finally(() => setCompleting(false))
    if (!result) return setCandidates([])
    if (result.candidates.length === 1) return apply(result.candidates[0]!)
    setCandidates(result.candidates)
    setSelected(0)
  }

  useBindings(() => ({
    target: textareaTarget,
    enabled: textareaTarget() !== undefined && !props.busy,
    // Dialog form semantics must win over the global managed textarea input layer.
    priority: 1,
    commands: [
      {
        name: "dialog.prompt.submit",
        title: "Submit dialog prompt",
        category: "Dialog",
        run: confirm,
      },
    ],
    bindings: [
      ...tuiConfig.keybinds.gather("dialog.prompt", ["dialog.prompt.submit"]),
      ...(props.complete
        ? [
            { key: "tab", desc: "Complete path", group: "Dialog", cmd: complete },
            {
              key: "up",
              desc: "Previous completion",
              group: "Dialog",
              cmd: () => {
                if (!candidates().length) return false
                setSelected((selected() - 1 + candidates().length) % candidates().length)
              },
            },
            {
              key: "down",
              desc: "Next completion",
              group: "Dialog",
              cmd: () => {
                if (!candidates().length) return false
                setSelected((selected() + 1) % candidates().length)
              },
            },
            {
              key: "escape",
              desc: "Close completions",
              group: "Dialog",
              cmd: () => {
                if (!candidates().length) return false
                setCandidates([])
                setSelected(0)
              },
            },
          ]
        : []),
    ],
  }))

  onMount(() => {
    dialog.setSize(props.complete ? "large" : "medium")
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      if (props.busy) return
      textarea.focus()
    }, 1)
    textarea.gotoLineEnd()
  })

  createEffect(() => {
    if (!textarea || textarea.isDestroyed) return
    const traits = props.busy
      ? {
          suspend: true,
          status: "BUSY",
        }
      : {}
    textarea.traits = traits
    if (props.busy) {
      textarea.blur()
      return
    }
    textarea.focus()
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description?.()}
        <textarea
          height={3}
          ref={(val: TextareaRenderable) => {
            textarea = val
            setTextareaTarget(val)
          }}
          initialValue={props.value}
          placeholder={props.placeholder ?? "Enter text"}
          placeholderColor={theme.textMuted}
          textColor={props.busy ? theme.textMuted : theme.text}
          focusedTextColor={props.busy ? theme.textMuted : theme.text}
          cursorColor={props.busy ? theme.backgroundElement : theme.text}
          cursorStyle={tuiConfig.cursor}
          onContentChange={() => {
            if (completedValue === textarea.plainText) {
              completedValue = undefined
              return
            }
            completedValue = undefined
            setCandidates([])
          }}
        />
        <Show when={props.busy}>
          <Spinner color={theme.textMuted}>{props.busyText ?? "Working…"}</Spinner>
        </Show>
        <Show when={completing()}>
          <Spinner color={theme.textMuted}>Reading directories…</Spinner>
        </Show>
        <Show when={candidates().length > 0}>
          <box flexDirection="column">
            <For each={visibleCandidates().items}>
              {(candidate, index) => (
                <text fg={visibleCandidates().start + index() === selected() ? theme.primary : theme.textMuted}>
                  {visibleCandidates().start + index() === selected() ? "› " : "  "}
                  {candidate}
                </text>
              )}
            </For>
            <text fg={theme.textMuted}>
              {selected() + 1}/{candidates().length}
            </text>
          </box>
        </Show>
      </box>
      <box paddingBottom={1} gap={1} flexDirection="row">
        <Show when={!props.busy} fallback={<text fg={theme.textMuted}>processing…</text>}>
          <Show when={submitShortcut()}>
            <text fg={theme.text}>
              {submitShortcut()} <span style={{ fg: theme.textMuted }}>submit</span>
            </text>
          </Show>
          <Show when={props.complete}>
            <text fg={theme.text}>
              tab <span style={{ fg: theme.textMuted }}>complete</span>
            </text>
          </Show>
        </Show>
      </box>
    </box>
  )
}

DialogPrompt.show = (dialog: DialogContext, title: string, options?: Omit<DialogPromptProps, "title">) => {
  return new Promise<string | null>((resolve) => {
    dialog.replace(
      () => (
        <DialogPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => resolve(null)} />
      ),
      () => resolve(null),
    )
  })
}
