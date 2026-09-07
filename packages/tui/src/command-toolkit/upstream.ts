import type { TuiUpstreamCommand } from "./host"
import { isCoreCommandMetadata } from "./host"

type KeymapEntry = {
  command: {
    name: string
    title?: unknown
    desc?: unknown
    category?: unknown
    hidden?: unknown
    slashName?: unknown
    slashAliases?: unknown
    commandKitIdentity?: unknown
  }
}

type ServerCommand = {
  name: string
  description?: string
  source?: "command" | "mcp" | "skill"
  provenance?:
    | { type: "builtin" }
    | { type: "custom" }
    | { type: "mcp"; serverID: string }
    | { type: "skill"; location: string }
}

function path(value: string) {
  return value.split(/[\t\v\f\r ]+/).filter(Boolean)
}

/**
 * Projects the existing TUI keymap without calling its handlers directly. The
 * keymap remains the lifecycle/availability owner for upstream and plugin
 * commands; dispatch by identity preserves hooks and legacy shims.
 */
export function adaptKeymapCommands(
  entries: readonly KeymapEntry[],
  dispatch: (identity: string) => Promise<unknown> | unknown,
): TuiUpstreamCommand[] {
  return entries.flatMap(({ command }) => {
    if (isCoreCommandMetadata(command)) return []
    if (typeof command.slashName !== "string" || !command.slashName) return []
    return [
      {
        id: command.name,
        path: path(command.slashName),
        aliases: Array.isArray(command.slashAliases)
          ? command.slashAliases.filter((item): item is string => typeof item === "string" && item.length > 0).map(path)
          : undefined,
        title: typeof command.title === "string" ? command.title : command.name,
        description: typeof command.desc === "string" ? command.desc : undefined,
        category: typeof command.category === "string" ? command.category : undefined,
        hidden: command.hidden === true,
        provenance: { type: "upstream", host: "tui", identity: command.name },
        dispatch: { type: "client", run: () => dispatch(command.name) },
      },
    ]
  })
}

/** Server prompt commands stay on the upstream `session.command` path. */
export function adaptServerCommands(commands: readonly ServerCommand[]): TuiUpstreamCommand[] {
  return commands.map((command) => ({
    id: `session.command:${command.name}`,
    path: [command.name],
    title: command.name,
    description: command.description,
    hidden: command.source === "skill",
    provenance:
      command.provenance?.type === "mcp"
        ? { type: "mcp", serverID: command.provenance.serverID }
        : command.provenance?.type === "skill"
          ? { type: "skill", location: command.provenance.location }
          : command.provenance?.type === "custom"
            ? { type: "custom-command" }
            : command.provenance?.type === "builtin"
              ? { type: "upstream", host: "session", identity: `builtin:${command.name}` }
              : command.source === "mcp"
                ? { type: "mcp", serverID: "unknown" }
                : command.source === "skill"
                  ? { type: "skill", location: "unknown" }
                  : { type: "custom-command" },
    dispatch: { type: "session", command: command.name },
  }))
}
