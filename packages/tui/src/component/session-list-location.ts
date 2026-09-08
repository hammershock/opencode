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
  status?: "unresolved" | "unavailable"
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
  const rawStatus =
    nonempty(session.locationStatus) ??
    nonempty(session.location?.status) ??
    nonempty(session.metadata?.locationStatus) ??
    nonempty(session.metadata?.locationResolution)
  const status =
    rawStatus === "unresolved" || rawStatus === "missing_local_target" || rawStatus === "unbound_portable_target"
      ? "unresolved"
      : rawStatus === "unavailable" || rawStatus === "target_unavailable"
        ? "unavailable"
        : undefined
  return {
    directory,
    target,
    device,
    status,
    label: `${target} · ${directory}`,
    search: [target, directory, device, status].filter(Boolean).join(" ").toLowerCase(),
  }
}

export function sessionListFooter(location: SessionListLocation, syncStatus: string | undefined, maxWidth: number) {
  const syncState = syncStatus?.replace(/^[●◐!×]\s*/, "")
  const status = location.status
    ? syncState && syncState !== location.status
      ? `! ${location.status}/${syncState}`
      : `! ${location.status}`
    : (syncStatus ?? "")
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
