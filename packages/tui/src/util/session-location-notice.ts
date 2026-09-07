import type { LocationRef } from "@opencode-ai/sdk/v2"

export type SessionLocationNotice = {
  readonly revision: number
  readonly previous: LocationRef
  readonly location: LocationRef
}

export function sessionLocationNoticeKey(sessionID: string) {
  return `session_location_changed:${sessionID}`
}

export function sessionLocationNotice(input: {
  readonly revision: number
  readonly previous: LocationRef
  readonly location: LocationRef
}): SessionLocationNotice {
  return { revision: input.revision, previous: input.previous, location: input.location }
}

export function sessionLocationNoticeText(notice: SessionLocationNotice) {
  const target = notice.location.target?.type === "rexd" ? (notice.location.lastKnownTargetName ?? "remote") : "local"
  return `Location changed · ${target} · ${notice.location.directory}`
}
