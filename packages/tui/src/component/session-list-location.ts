import { Locale } from "../util/locale"

export type SessionListLocationRecord = {
  directory: string
  location?: {
    directory?: string
    target?: string | { type?: string; name?: string; targetName?: string; targetID?: string }
    status?: string
  }
  target?: string | { type?: string; name?: string; targetName?: string; targetID?: string }
  targetName?: string
  targetLabel?: string
  portableTargetLabel?: string
  lastKnownTargetName?: string
  locationStatus?: string
  device?: string
  deviceName?: string
  sourceDeviceID?: string
  sync?: { device?: string; deviceName?: string }
  metadata?: Record<string, unknown>
}

export type SessionListLocation = {
  directory: string
  target: string
  device?: string
  label: string
  search: string
}

const nonempty = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export function sessionListLocation(session: SessionListLocationRecord): SessionListLocation {
  const targetValue = session.location?.target ?? session.target
  const portableTarget = nonempty(session.targetLabel) ?? nonempty(session.portableTargetLabel)
  const recordedTarget =
    portableTarget ??
    nonempty(session.lastKnownTargetName) ??
    nonempty(session.targetName) ??
    (typeof targetValue === "object"
      ? (nonempty(targetValue.name) ?? nonempty(targetValue.targetName))
      : nonempty(targetValue))
  const local =
    portableTarget === undefined &&
    ((typeof targetValue === "object" && targetValue.type === "local") ||
      targetValue === "local" ||
      (targetValue === undefined && recordedTarget === undefined))
  const target = local ? "local" : (recordedTarget ?? "remote")
  const directory = nonempty(session.location?.directory) ?? session.directory
  const device =
    nonempty(session.deviceName) ??
    nonempty(session.device) ??
    nonempty(session.sourceDeviceID) ??
    nonempty(session.sync?.deviceName) ??
    nonempty(session.sync?.device) ??
    nonempty(session.metadata?.deviceName) ??
    nonempty(session.metadata?.device)
  return {
    directory,
    target,
    device,
    label: `${target} · ${directory}`,
    search: [target, directory, device].filter(Boolean).join(" ").toLowerCase(),
  }
}

export function sessionListFooter(location: SessionListLocation, syncStatus: string | undefined, maxWidth: number) {
  const status = syncStatus ?? ""
  const width = Math.max(1, Math.floor(maxWidth))
  const detail = [location.label, location.device].filter(Boolean).join(" · ")
  const text = (() => {
    if (!status) return truncateMiddle(detail, width)
    if (status.length >= width) return truncateLeft(status, width)
    const available = width - status.length - 3
    if (available < 1) return truncateLeft(status, width)
    return `${truncateMiddle(detail, available)} · ${status}`
  })()
  return {
    text,
    detail,
    full: [location.label, location.device, status].filter(Boolean).join(" · "),
    status,
  }
}

export function sessionListMatches(session: SessionListLocationRecord & { title: string }, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${session.title.toLowerCase()} ${sessionListLocation(session).search}`.includes(needle)
}

function truncateMiddle(value: string, width: number) {
  if (width === 1 && value.length > 1) return "…"
  return Locale.truncateMiddle(value, width)
}

function truncateLeft(value: string, width: number) {
  if (width === 1 && value.length > 1) return "…"
  return Locale.truncateLeft(value, width)
}
