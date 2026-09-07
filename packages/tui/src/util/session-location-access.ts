import type { TuiRouteCurrent } from "@opencode-ai/plugin/tui"
import type { SessionLocationRebindingResolution } from "@opencode-ai/sdk/v2"

export function permitsRouteLocationActions(route: TuiRouteCurrent) {
  return route.name !== "session" || route.params?.accessMode === "read-write"
}

export function localEditorDirectory(resolution: SessionLocationRebindingResolution) {
  if (resolution.status !== "resolved") return
  if (resolution.location.target && resolution.location.target.type !== "local") return
  return resolution.location.directory
}
