import type { EventSyncTransferUpdated } from "@opencode-ai/sdk/v2"
import { useTheme } from "../context/theme"

type ActiveTransfer = Exclude<EventSyncTransferUpdated["properties"]["progress"], { state: "idle" }>

export function syncTransferSummary(progress: ActiveTransfer) {
  const direction = progress.direction === "upload" ? "↑" : "↓"
  const counts = [progress.items ? String(progress.items) : undefined, formatBytes(progress.bytes)].filter(Boolean)
  return [`◐ ${direction} ${progress.phase}`, ...counts].join(" · ")
}

export function SyncTransferSummary(props: { readonly progress: ActiveTransfer }) {
  const { theme } = useTheme()
  return <text fg={theme.warning}>{syncTransferSummary(props.progress)}</text>
}

function formatBytes(bytes?: number) {
  if (!bytes) return
  if (bytes < 1_024) return `${bytes} B`
  if (bytes < 1024 * 1_024) return `${trim(bytes / 1_024)} KB`
  return `${trim(bytes / (1_024 * 1_024))} MB`
}

function trim(value: number) {
  return value >= 10 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "")
}
