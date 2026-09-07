import { Show } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { useRemoteStatus } from "../context/remote-status"
import { useTheme } from "../context/theme"

export function RemoteStatusBar() {
  const status = useRemoteStatus()
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()

  return (
    <Show when={status.current()}>
      {(item) => (
        <box
          position="absolute"
          top={0}
          right={1}
          maxWidth={Math.max(24, Math.min(88, dimensions().width - 4))}
          flexDirection="column"
          paddingLeft={1}
          paddingRight={1}
          backgroundColor={theme.backgroundPanel}
        >
          <text fg={item().state === "failed" ? theme.error : theme.warning}>
            {item().state === "failed" ? "!" : "◐"} {item().area} · {item().operation}
            {item().phase ? ` · ${item().phase}` : ""}
          </text>
          <Show when={item().state === "failed" && item().detail}>
            <text fg={theme.textMuted} wrapMode="word" width="100%">
              {item().detail}
            </text>
          </Show>
        </box>
      )}
    </Show>
  )
}
