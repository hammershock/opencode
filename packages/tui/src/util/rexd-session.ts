import { createHash, randomUUID } from "crypto"
import { spawn } from "child_process"
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
  port?: number
  identityFile?: string
  sshOptions?: string[]
  command?: string
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
  const configured = state.remoteCwdOverride ?? target?.defaultCwd ?? target?.workspaceRoots?.[0] ?? "/"
  const directory = expandRemoteHome(configured, target)
  return { target: state.activeTargetAlias, directory, label: `${state.activeTargetAlias}:${directory}` }
}

function expandRemoteHome(value: string, target?: Target) {
  if (!value.startsWith("~")) return value
  const home = target?.home ?? (target?.user === "root" ? "/root" : target?.user ? `/home/${target.user}` : "~")
  if (value === "~") return home
  if (value.startsWith("~/") && home !== "~") return path.posix.join(home, value.slice(2))
  return value
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

export function hasRexdTarget(home: string, alias: string) {
  const config = readJson<{ targets?: Record<string, Target> }>(path.join(home, ".config", "rexd", "targets.json"))
  return Boolean(config?.targets?.[alias])
}

const REXD_COMMAND = "$HOME/.local/bin/rexd --stdio --config $HOME/.config/rexd/config.toml"

export function addQuickRexdTarget(home: string, alias: string) {
  return addRexdTarget(home, {
    alias,
    host: alias,
    defaultCwd: "~",
    workspaceRoots: ["/"],
    command: REXD_COMMAND,
  })
}

export async function prepareRexdTarget(home: string, alias: string) {
  const file = path.join(home, ".config", "rexd", "targets.json")
  const config = readJson<{ version?: number; targets?: Record<string, Target> }>(file) ?? {}
  const target = config.targets?.[alias]
  if (!target) throw new Error(`Target "${alias}" not found`)
  if (target.transport !== "ssh" || !target.host) throw new Error(`Target "${alias}" is not an SSH target`)

  const args: string[] = []
  if (target.port) args.push("-p", String(target.port))
  if (target.identityFile) args.push("-i", target.identityFile)
  if (target.sshOptions?.length) args.push(...target.sshOptions)
  args.push("-T", target.user ? `${target.user}@${target.host}` : target.host, "bash", "-s")

  const script = `set -eu
bin="$HOME/.local/bin/rexd"
config="$HOME/.config/rexd/config.toml"
if [ ! -x "$bin" ]; then
  echo "Installing REXD"
  command -v curl >/dev/null 2>&1 || { echo "curl is required to install REXD" >&2; exit 1; }
  command -v tar >/dev/null 2>&1 || { echo "tar is required to install REXD" >&2; exit 1; }
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;; esac
  version="$(curl -fsSL https://api.github.com/repos/samiralibabic/rexd/releases/latest | sed -n 's/.*"tag_name":[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n1)"
  [ -n "$version" ] || { echo "Could not resolve the latest REXD version" >&2; exit 1; }
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  asset="rexd-linux-$arch.tar.gz"
  base="https://github.com/samiralibabic/rexd/releases/download/$version"
  curl -fsSL "$base/$asset" -o "$tmp/$asset"
  curl -fsSL "$base/checksums.txt" -o "$tmp/checksums.txt"
  expected="$(awk \"/  $asset\\$/{print \\\$1}\" "$tmp/checksums.txt")"
  actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  [ -n "$expected" ] && [ "$expected" = "$actual" ] || { echo "REXD checksum mismatch" >&2; exit 1; }
  tar -xzf "$tmp/$asset" -C "$tmp"
  mkdir -p "$HOME/.local/bin"
  install -m 0755 "$tmp/rexd-linux-$arch" "$bin"
fi
if [ ! -f "$config" ]; then
  mkdir -p "$HOME/.config/rexd"
  cat >"$config" <<'REXD_CONFIG'
[server]
stdio = true
http_listen = ""
http_path = "/rpc"
ws_path = "/ws"
log_level = "info"

[limits]
default_timeout_ms = 30000
hard_timeout_ms = 300000
max_output_bytes = 1048576
max_file_read_bytes = 1048576
max_processes_per_session = 8
max_concurrent_sessions = 16

[security]
allow_shell = true

[[security.allowed_roots]]
path = "/"

[audit]
enabled = false
path = "/tmp/rexd-audit.log"
REXD_CONFIG
fi
"$bin" -h >/dev/null 2>&1
probe="$(printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"session.open","params":{"client_name":"opencode-rexd-bootstrap","client_version":"1","workspace_roots":["/"]}}' | "$bin" --stdio --config "$config")"
printf '%s' "$probe" | grep -q '"result"' || { echo "REXD handshake failed" >&2; exit 1; }
printf '__OPENCODE_REXD_HOME__=%s\n' "$HOME"
`
  const result = await runSsh(args, script)
  const remoteHome = result.stdout.match(/^__OPENCODE_REXD_HOME__=(.+)$/m)?.[1]?.trim()
  if (!remoteHome?.startsWith("/")) throw new Error("REXD installed, but the remote home directory could not be detected")
  const next = {
    ...target,
    home: remoteHome,
    command: REXD_COMMAND,
  }
  writeJson(file, { ...config, version: config.version ?? 1, targets: { ...config.targets, [alias]: next } })
  return { alias, home: remoteHome, installed: result.stdout.includes("Installing REXD") }
}

function runSsh(args: string[], input: string) {
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error("SSH preparation timed out after 120 seconds"))
    }, 120_000)
    child.stdout.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(stderr.trim() || stdout.trim() || `SSH exited with code ${code}`))
    })
    child.stdin.end(input)
  })
}

export function addRexdTarget(
  home: string,
  input: {
    alias: string
    host: string
    user?: string
    defaultCwd: string
    workspaceRoots: string[]
    command: string
  },
) {
  const alias = input.alias.trim()
  if (!/^[A-Za-z0-9._-]+$/.test(alias)) throw new Error("Alias may only contain letters, numbers, '.', '_' and '-'")
  if (!input.host.trim()) throw new Error("SSH host is required")
  const rawDefaultCwd = input.defaultCwd.trim()
  const defaultCwd = rawDefaultCwd === "~" ? "~" : path.posix.normalize(rawDefaultCwd)
  if (defaultCwd !== "~" && !defaultCwd.startsWith("/")) throw new Error("Default working directory must be absolute or ~")
  const roots = input.workspaceRoots.map((root) => path.posix.normalize(root.trim())).filter(Boolean)
  if (!roots.length || roots.some((root) => !root.startsWith("/"))) {
    throw new Error("Workspace roots must contain absolute paths")
  }

  const file = path.join(home, ".config", "rexd", "targets.json")
  const config = readJson<{ version?: number; targets?: Record<string, Target> }>(file) ?? {}
  const target = {
    transport: "ssh",
    host: input.host.trim(),
    ...(input.user?.trim() ? { user: input.user.trim() } : {}),
    command: input.command.trim(),
    workspaceRoots: roots,
    defaultCwd,
    rootPolicy: { mode: "strict" },
  }
  writeJson(file, { ...config, version: config.version ?? 1, targets: { ...config.targets, [alias]: target } })
  return { alias, target }
}

function writeState(file: string, state: SessionState) {
  writeJson(file, state)
}

function writeJson(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n")
  renameSync(temporary, file)
}
