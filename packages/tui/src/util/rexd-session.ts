import { createHash, randomUUID } from "crypto"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"

type SessionState = {
  activeTargetAlias: string | null
  remoteCwdOverride: string | null
  lastUsedAt: number
}

type Target = {
  transport?: string
  host?: string
  user?: string
  home?: string
  description?: string
  defaultCwd?: string
  workspaceRoots?: string[]
}

function statePath(home: string, sessionID: string) {
  const name = createHash("sha256").update(sessionID).digest("hex") + ".json"
  return path.join(home, ".config", "opencode", "rexd-target", "sessions", name)
}

export function readRexdSession(home: string, sessionID: string) {
  const file = statePath(home, sessionID)
  if (!existsSync(file)) return
  const state = readJson<SessionState>(file)
  if (!state) return
  if (!state.activeTargetAlias) return

  const configFile = path.join(home, ".config", "rexd", "targets.json")
  const config = readJson<{ targets?: Record<string, Target> }>(configFile)
  const target = config?.targets?.[state.activeTargetAlias]
  const directory = state.remoteCwdOverride ?? target?.defaultCwd ?? target?.workspaceRoots?.[0] ?? "/"
  return { target: state.activeTargetAlias, directory, label: `${state.activeTargetAlias}:${directory}` }
}

function readJson<Value>(file: string) {
  if (!existsSync(file)) return
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Value
  } catch {
    return
  }
}

export function writeRexdSessionDirectory(home: string, sessionID: string, directory: string) {
  const file = statePath(home, sessionID)
  if (!existsSync(file)) return false
  const state = JSON.parse(readFileSync(file, "utf8")) as SessionState
  if (!state.activeTargetAlias) return false

  const normalized = path.posix.normalize(directory.trim())
  if (!normalized.startsWith("/")) throw new Error("Remote working directory must be an absolute path")
  const config = readJson<{ targets?: Record<string, Target> }>(path.join(home, ".config", "rexd", "targets.json"))
  const roots = config?.targets?.[state.activeTargetAlias]?.workspaceRoots?.map((root) => path.posix.normalize(root)) ?? []
  if (roots.length && !roots.some((root) => normalized === root || normalized.startsWith(root.replace(/\/$/, "") + "/"))) {
    throw new Error(`Remote working directory must be inside: ${roots.join(", ")}`)
  }
  const next = { ...state, remoteCwdOverride: normalized, lastUsedAt: Date.now() }
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(next, null, 2))
  renameSync(temporary, file)
  return true
}

export function changeRexdSessionDirectory(home: string, sessionID: string, input: string) {
  const current = readRexdSession(home, sessionID)
  if (!current) return
  const config = readJson<{ targets?: Record<string, Target> }>(path.join(home, ".config", "rexd", "targets.json"))
  const target = config?.targets?.[current.target]
  const remoteHome = target?.home ?? (target?.user === "root" ? "/root" : target?.user ? `/home/${target.user}` : "/")
  const value = parseDirectoryArgument(input)
  const expanded = value === "~" ? remoteHome : value.startsWith("~/") ? path.posix.join(remoteHome, value.slice(2)) : value
  const directory = expanded.startsWith("/") ? expanded : path.posix.join(current.directory, expanded)
  writeRexdSessionDirectory(home, sessionID, directory)
  return readRexdSession(home, sessionID)
}

export function parseDirectoryArgument(input: string) {
  const value = input.trim()
  if (!value) return "~"
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value.replace(/\\ /g, " ")
}

export function executeRexdTargetCommand(home: string, sessionID: string, input: string) {
  const [action = "status", alias, ...extra] = input.trim().split(/\s+/)
  if (extra.length) return { title: "REXD target", message: "Usage: /target <list|use|status|clear> [alias]" }
  const config = readJson<{ targets?: Record<string, Target> }>(path.join(home, ".config", "rexd", "targets.json"))
  const targets = config?.targets ?? {}

  if (action === "list") {
    const active = readRexdSession(home, sessionID)?.target
    const list = Object.entries(targets)
      .map(([name, target]) => `  ${active === name ? "*" : " "} ${name}: ${target.description ?? target.host ?? "No description"}`)
      .join("\n")
    return {
      title: "REXD targets",
      message: list ? `Available targets:\n${list}` : "No targets configured. Create ~/.config/rexd/targets.json",
    }
  }

  if (action === "status") {
    const current = readRexdSession(home, sessionID)
    return {
      title: "REXD target status",
      message: current ? `Target: ${current.target}\nWorking directory: ${current.directory}` : "No remote target selected.",
    }
  }

  if (action === "use") {
    if (!alias) return { title: "REXD target", message: "Usage: /target use <alias>" }
    const target = targets[alias]
    if (!target) return { title: "REXD target", message: `Target \"${alias}\" not found.` }
    if (target.transport !== "ssh") {
      return { title: "REXD target", message: `Target \"${alias}\" uses unsupported transport \"${target.transport}\".` }
    }
    const file = statePath(home, sessionID)
    const previous = readJson<SessionState>(file)
    writeState(file, {
      activeTargetAlias: alias,
      remoteCwdOverride: previous?.activeTargetAlias === alias ? previous.remoteCwdOverride : null,
      lastUsedAt: Date.now(),
    })
    return {
      title: "REXD target selected",
      message: `${alias}:${readRexdSession(home, sessionID)?.directory ?? "/"}`,
    }
  }

  if (action === "clear") {
    const file = statePath(home, sessionID)
    const previous = readJson<SessionState>(file)
    writeState(file, { activeTargetAlias: null, remoteCwdOverride: null, lastUsedAt: Date.now() })
    return {
      title: "REXD target cleared",
      message: previous?.activeTargetAlias ? `Disconnected from ${previous.activeTargetAlias}.` : "No remote target was selected.",
    }
  }

  return { title: "REXD target", message: "Usage: /target <list|use|status|clear> [alias]" }
}

function writeState(file: string, state: SessionState) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(state, null, 2))
  renameSync(temporary, file)
}
