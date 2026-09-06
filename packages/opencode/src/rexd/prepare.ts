import { artifactURL, REXD_ARTIFACTS, REXD_BASELINE_VERSION, type RexdPlatform } from "./manifest"
import { RexdError } from "./error"
import { runSshScript, type RexdTarget } from "./ssh"

export type RemotePlatform = {
  platform: RexdPlatform
  home: string
  dataHome: string
  configHome: string
  wsl: boolean
}

export type PrepareResult = RemotePlatform & {
  installed: boolean
  binary: string
  config: string
}

export type PrepareDependencies = {
  run?: typeof runSshScript
}

export async function detectRemotePlatform(
  target: RexdTarget,
  signal?: AbortSignal,
  dependencies: PrepareDependencies = {},
): Promise<RemotePlatform> {
  const result = await (dependencies.run ?? runSshScript)(target.connection, DETECT_SCRIPT, signal).catch((error) => {
    if (error instanceof RexdError) throw error
    throw new RexdError("detect", "Could not detect remote environment", true)
  })
  const fields = result.stdout.trimEnd().split("\n")
  if (fields.length !== 6 || fields.some((field) => !field)) {
    throw new RexdError("detect", "Remote environment probe returned invalid data", false)
  }
  if (fields[0] !== "Linux")
    throw new RexdError("unsupported-platform", `Managed Rexd does not support ${fields[0]}`, false)
  const architecture =
    fields[1] === "x86_64" || fields[1] === "amd64"
      ? "amd64"
      : fields[1] === "aarch64" || fields[1] === "arm64"
        ? "arm64"
        : undefined
  if (!architecture)
    throw new RexdError("unsupported-platform", `Managed Rexd does not support Linux ${fields[1]}`, false)
  if (!fields[2]!.startsWith("/")) throw new RexdError("detect", "Remote HOME is not an absolute path", false)
  return {
    platform: `linux-${architecture}`,
    home: fields[2]!,
    dataHome: fields[3]!,
    configHome: fields[4]!,
    wsl: fields[5] === "wsl",
  }
}

export async function prepareManagedRexd(
  target: RexdTarget,
  signal?: AbortSignal,
  dependencies: PrepareDependencies = {},
): Promise<PrepareResult> {
  const remote = await detectRemotePlatform(target, signal, dependencies)
  const artifact = REXD_ARTIFACTS[remote.platform]
  const binary = `${remote.dataHome}/opencode/rexd/${REXD_BASELINE_VERSION}/rexd`
  const config = `${remote.configHome}/opencode/rexd/config.toml`
  const result = await (dependencies.run ?? runSshScript)(
    target.connection,
    installScript({
      binary,
      config,
      artifact: artifact.name,
      checksum: artifact.sha256,
      url: artifactURL(remote.platform),
      roots: target.workspaceRoots,
    }),
    signal,
  ).catch((error) => {
    if (error instanceof RexdError) throw classifyInstallError(error)
    throw new RexdError("install", "Could not prepare managed Rexd", true)
  })
  const status = result.stdout.trim()
  if (status !== "ready" && status !== "installed") {
    throw new RexdError("install", "Managed Rexd installer returned invalid status", false)
  }
  return { ...remote, installed: status === "installed", binary, config }
}

export function managedRexdCommand(result: Pick<PrepareResult, "binary" | "config">) {
  return `exec ${shellQuote(result.binary)} --stdio --config ${shellQuote(result.config)}`
}

function installScript(input: {
  binary: string
  config: string
  artifact: string
  checksum: string
  url: string
  roots: readonly string[]
}) {
  const binaryDirectory = input.binary.slice(0, input.binary.lastIndexOf("/"))
  const configDirectory = input.config.slice(0, input.config.lastIndexOf("/"))
  const rootConfig = input.roots.map((root) => `[[security.allowed_roots]]\npath = ${tomlString(root)}`).join("\n\n")
  const config = `[server]\nstdio = true\nhttp_listen = ""\nlog_level = "info"\n\n[limits]\ndefault_timeout_ms = 30000\nhard_timeout_ms = 300000\nmax_output_bytes = 1048576\nmax_file_read_bytes = 1048576\nmax_processes_per_session = 8\nmax_concurrent_sessions = 16\n\n[security]\nallow_shell = true\n\n${rootConfig}\n\n[audit]\nenabled = false\n`
  return `set -eu
binary=${shellQuote(input.binary)}
config=${shellQuote(input.config)}
marker="$binary.sha256"
lock=${shellQuote(`${binaryDirectory}.lock`)}
temporary=""
cleanup() { [ -n "$temporary" ] && rm -rf "$temporary"; rmdir "$lock" 2>/dev/null || true; }
trap cleanup EXIT HUP INT TERM
attempt=0
while ! mkdir "$lock" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { echo "OPENCODE_REXD_PHASE=install lock timeout" >&2; exit 71; }
  sleep 0.1
done
mkdir -p ${shellQuote(binaryDirectory)} ${shellQuote(configDirectory)}
installed=0
if [ ! -x "$binary" ] || [ ! -f "$marker" ] || [ "$(cat "$marker")" != ${shellQuote(input.checksum)} ]; then
  command -v curl >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=download curl unavailable" >&2; exit 72; }
  command -v tar >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=install tar unavailable" >&2; exit 73; }
  command -v sha256sum >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=checksum sha256sum unavailable" >&2; exit 74; }
  temporary="$(mktemp -d)"
  curl -fsSL --proto '=https' --tlsv1.2 ${shellQuote(input.url)} -o "$temporary/${input.artifact}" || { echo "OPENCODE_REXD_PHASE=download failed" >&2; exit 75; }
  actual="$(sha256sum "$temporary/${input.artifact}" | cut -d' ' -f1)"
  [ "$actual" = ${shellQuote(input.checksum)} ] || { echo "OPENCODE_REXD_PHASE=checksum mismatch" >&2; exit 76; }
  tar -xzf "$temporary/${input.artifact}" -C "$temporary" || { echo "OPENCODE_REXD_PHASE=install extract failed" >&2; exit 77; }
  install -m 0755 "$temporary/${input.artifact.slice(0, -".tar.gz".length)}" "$temporary/rexd.next"
  mv "$temporary/rexd.next" "$binary"
  printf '%s' ${shellQuote(input.checksum)} >"$temporary/marker.next"
  chmod 0600 "$temporary/marker.next"
  mv "$temporary/marker.next" "$marker"
  installed=1
fi
cat >"$config.next" <<'OPENCODE_REXD_CONFIG'
${config}OPENCODE_REXD_CONFIG
chmod 0600 "$config.next"
mv "$config.next" "$config"
"$binary" --version >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=install binary invalid" >&2; exit 78; }
[ "$installed" -eq 1 ] && printf 'installed\n' || printf 'ready\n'
`
}

function classifyInstallError(error: RexdError) {
  const marker = /OPENCODE_REXD_PHASE=(download|checksum|install)/.exec(error.diagnostic ?? "")?.[1]
  if (!marker) return error
  if (marker !== "download" && marker !== "checksum" && marker !== "install") return error
  return new RexdError(marker, `Managed Rexd ${marker} failed`, marker !== "checksum", "failed", error.diagnostic)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function tomlString(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r")}"`
}

const DETECT_SCRIPT = `set -eu
home="\${HOME:-}"
if [ -z "$home" ] || [ "\${home#/}" = "$home" ]; then
  home="$(getent passwd "$(id -u)" | cut -d: -f6)"
fi
[ -n "$home" ] || { echo "missing HOME" >&2; exit 1; }
data="\${XDG_DATA_HOME:-$home/.local/share}"
config="\${XDG_CONFIG_HOME:-$home/.config}"
case "$(cat /proc/version 2>/dev/null || true)" in *[Mm]icrosoft*) environment=wsl ;; *) environment=linux ;; esac
printf '%s\n%s\n%s\n%s\n%s\n%s\n' "$(uname -s)" "$(uname -m)" "$home" "$data" "$config" "$environment"
`
