import { abbreviateHome } from "../runtime"
import { sessionListLocation, type SessionListLocationRecord } from "./session-list-location"

export function sessionFooterLocation(input: {
  session?: SessionListLocationRecord
  fallbackDirectory: string
  home: string
  branch?: string
}) {
  const location = sessionListLocation(input.session ?? { directory: input.fallbackDirectory })
  const directory = abbreviateHome(location.directory, input.home)
  return {
    target: location.target,
    directory: input.branch ? `${directory}:${input.branch}` : directory,
    label: `${location.target} · ${input.branch ? `${directory}:${input.branch}` : directory}`,
  }
}
