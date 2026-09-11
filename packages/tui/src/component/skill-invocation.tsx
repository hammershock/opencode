import type { SessionSkillInvocationSnapshot } from "@opencode-ai/sdk/v2"
import { createMemo, createSignal, Show } from "solid-js"
import { useTheme } from "../context/theme"
import { Locale } from "../util/locale"

export function SkillInvocationRow(props: {
  snapshot: SessionSkillInvocationSnapshot
  width: number
  expanded?: boolean
  onToggle?: () => void
}) {
  const { theme } = useTheme()
  const [localExpanded, setLocalExpanded] = createSignal(false)
  const expanded = () => props.expanded ?? localExpanded()
  const name = createMemo(() => Locale.truncateMiddle(props.snapshot.name, Math.max(8, props.width - 28)))
  const toggle = () => (props.onToggle ? props.onToggle() : setLocalExpanded((current) => !current))

  return (
    <box
      focusable
      border={["left"]}
      borderColor={expanded() ? theme.accent : theme.border}
      focusedBorderColor={theme.accent}
      marginTop={1}
      paddingLeft={1}
      onMouseUp={(event) => {
        event.stopPropagation()
        toggle()
      }}
      onKeyDown={(event) => {
        if (event.name !== "return") return
        event.preventDefault()
        event.stopPropagation()
        toggle()
      }}
    >
      <text fg={theme.textMuted} wrapMode="none">
        <span style={{ fg: theme.success }}>●</span> Skill · {name()}
        <Show when={props.width > 60}> · {props.snapshot.source.label}</Show> · {props.snapshot.status}
        <Show when={props.width > 48}> · {expanded() ? "collapse" : "Enter to expand"}</Show>
      </text>
      <Show when={expanded()}>
        <text fg={theme.text}>{props.snapshot.content}</text>
      </Show>
    </box>
  )
}
