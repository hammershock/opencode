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
  target?: string
  device?: string
  status?: "unresolved" | "unavailable"
  label: string
  search: string
}

const nonempty = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

export function sessionListLocation(session: SessionListLocationRecord): SessionListLocation {
  const targetValue = session.location?.target ?? session.target
  const target =
    nonempty(session.lastKnownTargetName) ??
    nonempty(session.targetName) ??
    nonempty(session.targetLabel) ??
    (typeof targetValue === "object"
      ? (nonempty(targetValue.name) ?? nonempty(targetValue.targetName) ?? nonempty(targetValue.targetID))
      : nonempty(targetValue))
  const local = typeof targetValue === "object" && targetValue.type === "local"
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
  const location = target && !local ? `${target} · ${directory}` : directory
  const statusLabel = status ? ` · ${status}` : ""
  const deviceLabel = device ? ` · ${device}` : ""
  return {
    directory,
    target: target && !local ? target : undefined,
    device,
    status,
    label: `${location}${deviceLabel}${statusLabel}`,
    search: [target, directory, device, status].filter(Boolean).join(" ").toLowerCase(),
  }
}

export function sessionListMatches(session: SessionListLocationRecord & { title: string }, query: string) {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${session.title.toLowerCase()} ${sessionListLocation(session).search}`.includes(needle)
}
