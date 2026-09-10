import { artifactURL, REXD_ARTIFACTS, REXD_BASELINE_VERSION, type RexdPlatform } from "./manifest"
import { RexdError } from "./error"
import { runSshInput, runSshScript, type RexdTarget } from "./ssh"

export const REMOTE_DETECT_TIMEOUT_MS = 8_000

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
  upload?: typeof runSshInput
  download?: (url: string, signal?: AbortSignal) => Promise<Uint8Array>
  verify?: (payload: Uint8Array, expected: string) => void
  detectTimeoutMs?: number
}

export async function detectRemotePlatform(
  target: RexdTarget,
  signal?: AbortSignal,
  dependencies: PrepareDependencies = {},
): Promise<RemotePlatform> {
  const result = await withDetectionDeadline(
    (operationSignal) => (dependencies.run ?? runSshScript)(target.connection, DETECT_SCRIPT, operationSignal),
    signal,
    dependencies.detectTimeoutMs,
  ).catch((error) => {
    if (error instanceof RexdError) throw error
    throw new RexdError("detect", "Could not detect remote environment", true)
  })
  const fields = result.stdout.trimEnd().split("\n")
  if (fields.length !== 6 || fields.some((field) => !field)) {
    throw new RexdError("detect", "Remote environment probe returned invalid data", false)
  }
  const system = fields[0] === "Linux" ? "linux" : fields[0] === "Darwin" ? "darwin" : undefined
  if (!system) throw new RexdError("unsupported-platform", `Managed Rexd does not support ${fields[0]}`, false)
  const architecture =
    fields[1] === "x86_64" || fields[1] === "amd64"
      ? "amd64"
      : fields[1] === "aarch64" || fields[1] === "arm64"
        ? "arm64"
        : undefined
  if (!architecture)
    throw new RexdError("unsupported-platform", `Managed Rexd does not support ${fields[0]} ${fields[1]}`, false)
  if (!fields[2]!.startsWith("/")) throw new RexdError("detect", "Remote HOME is not an absolute path", false)
  return {
    platform: `${system}-${architecture}`,
    home: fields[2]!,
    dataHome: fields[3]!,
    configHome: fields[4]!,
    wsl: fields[5] === "wsl",
  }
}

async function withDetectionDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
  timeoutMs = REMOTE_DETECT_TIMEOUT_MS,
) {
  if (parent?.aborted) throw new RexdError("cancelled", "Rexd operation cancelled", true)
  const controller = new AbortController()
  const cancel = () => controller.abort(parent?.reason)
  parent?.addEventListener("abort", cancel, { once: true })
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(new DOMException("Remote environment detection timed out", "TimeoutError"))
      reject(
        new RexdError(
          "ssh",
          `SSH connection timed out after ${timeoutMs / 1_000} seconds`,
          true,
          "unknown",
          "TimeoutError",
        ),
      )
    }, timeoutMs)
    timer.unref?.()
  })
  try {
    return await Promise.race([operation(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
    parent?.removeEventListener("abort", cancel)
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
  )
    .catch((error) => {
      if (error instanceof RexdError) throw classifyInstallError(error)
      throw new RexdError("install", "Could not prepare managed Rexd", true)
    })
    .catch(async (error) => {
      if (!(error instanceof RexdError) || error.phase !== "download") throw error
      const payload = await (dependencies.download ?? downloadArtifact)(artifactURL(remote.platform), signal)
      ;(dependencies.verify ?? verifyArtifact)(payload, artifact.sha256)
      return (dependencies.upload ?? runSshInput)(
        target.connection,
        `sh -c ${shellQuote(
          uploadScript({
            binary,
            config,
            artifact: artifact.name,
            checksum: artifact.sha256,
            roots: target.workspaceRoots,
          }),
        )}`,
        payload,
        signal,
      ).catch((failure) => {
        if (failure instanceof RexdError) throw classifyInstallError(failure)
        throw new RexdError("install", "Could not upload managed Rexd", true)
      })
    })
  const status = result.stdout.trim()
  if (status !== "ready" && status !== "installed") {
    throw new RexdError("install", "Managed Rexd installer returned invalid status", false)
  }
  return { ...remote, installed: status === "installed", binary, config }
}

async function downloadArtifact(url: string, signal?: AbortSignal) {
  const response = await fetch(url, { signal }).catch(() => undefined)
  if (!response?.ok) throw new RexdError("download", "Could not download managed Rexd on the control device", true)
  return new Uint8Array(await response.arrayBuffer())
}

function verifyArtifact(payload: Uint8Array, expected: string) {
  const actual = new Bun.CryptoHasher("sha256").update(payload).digest("hex")
  if (actual !== expected) throw new RexdError("checksum", "Managed Rexd checksum verification failed", false)
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
  return transactionScript(
    input,
    `installed=0
if [ ! -x "$binary" ] || [ ! -f "$marker" ] || [ "$(cat "$marker")" != ${shellQuote(input.checksum)} ]; then
  command -v curl >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=download curl unavailable" >&2; exit 72; }
  command -v tar >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=install tar unavailable" >&2; exit 73; }
  if command -v sha256sum >/dev/null 2>&1; then checksum() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else echo "OPENCODE_REXD_PHASE=checksum SHA-256 utility unavailable" >&2; exit 74; fi
  temporary="$(mktemp -d)"
  curl -fsSL --connect-timeout 5 --max-time 30 --proto '=https' --tlsv1.2 ${shellQuote(input.url)} -o "$temporary/${input.artifact}" || { echo "OPENCODE_REXD_PHASE=download failed" >&2; exit 75; }
  actual="$(checksum "$temporary/${input.artifact}")"
  [ "$actual" = ${shellQuote(input.checksum)} ] || { echo "OPENCODE_REXD_PHASE=checksum mismatch" >&2; exit 76; }
  tar -xzf "$temporary/${input.artifact}" -C "$temporary" || { echo "OPENCODE_REXD_PHASE=install extract failed" >&2; exit 77; }
  install -m 0755 "$temporary/${input.artifact.slice(0, -".tar.gz".length)}" "$binary_next" || { echo "OPENCODE_REXD_PHASE=install binary staging failed" >&2; exit 77; }
  printf '%s' ${shellQuote(input.checksum)} >"$marker_next" || { echo "OPENCODE_REXD_PHASE=install marker staging failed" >&2; exit 77; }
  chmod 0600 "$marker_next" || { echo "OPENCODE_REXD_PHASE=install marker staging failed" >&2; exit 77; }
  installed=1
else
  cp -p "$binary" "$binary_next" || { echo "OPENCODE_REXD_PHASE=install binary staging failed" >&2; exit 77; }
  cp -p "$marker" "$marker_next" || { echo "OPENCODE_REXD_PHASE=install marker staging failed" >&2; exit 77; }
fi
`,
    `[ "$installed" -eq 1 ] && printf 'installed\\n' || printf 'ready\\n'`,
  )
}

function uploadScript(input: {
  binary: string
  config: string
  artifact: string
  checksum: string
  roots: readonly string[]
}) {
  return transactionScript(
    input,
    `temporary="$(mktemp -d)"
cat >"$temporary/${input.artifact}"
command -v tar >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=install tar unavailable" >&2; exit 73; }
if command -v sha256sum >/dev/null 2>&1; then checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else echo "OPENCODE_REXD_PHASE=checksum SHA-256 utility unavailable" >&2; exit 74; fi
actual="$(checksum "$temporary/${input.artifact}")"
[ "$actual" = ${shellQuote(input.checksum)} ] || { echo "OPENCODE_REXD_PHASE=checksum mismatch" >&2; exit 76; }
tar -xzf "$temporary/${input.artifact}" -C "$temporary" || { echo "OPENCODE_REXD_PHASE=install extract failed" >&2; exit 77; }
install -m 0755 "$temporary/${input.artifact.slice(0, -".tar.gz".length)}" "$binary_next" || { echo "OPENCODE_REXD_PHASE=install binary staging failed" >&2; exit 77; }
printf '%s' ${shellQuote(input.checksum)} >"$marker_next" || { echo "OPENCODE_REXD_PHASE=install marker staging failed" >&2; exit 77; }
chmod 0600 "$marker_next" || { echo "OPENCODE_REXD_PHASE=install marker staging failed" >&2; exit 77; }
`,
    `printf 'installed\\n'`,
  )
}

function transactionScript(
  input: { binary: string; config: string; checksum: string; roots: readonly string[] },
  stageBinary: string,
  status: string,
) {
  const binaryDirectory = input.binary.slice(0, input.binary.lastIndexOf("/"))
  const managedDirectory = binaryDirectory.slice(0, binaryDirectory.lastIndexOf("/"))
  const configDirectory = input.config.slice(0, input.config.lastIndexOf("/"))
  const rootConfig = input.roots.map((root) => `[[security.allowed_roots]]\npath = ${tomlString(root)}`).join("\n\n")
  const config = `[server]\nstdio = true\nhttp_listen = ""\nlog_level = "info"\n\n[limits]\ndefault_timeout_ms = 30000\nhard_timeout_ms = 300000\nmax_output_bytes = 1048576\nmax_file_read_bytes = 1048576\nmax_processes_per_session = 8\nmax_concurrent_sessions = 16\n\n[security]\nallow_shell = true\n\n${rootConfig}\n\n[audit]\nenabled = false\n`
  return `set -eu
binary=${shellQuote(input.binary)}
config=${shellQuote(input.config)}
marker="$binary.sha256"
lock=${shellQuote(`${binaryDirectory}.lock`)}
temporary=""
owned=0
transaction=0
committed=0
binary_had=0
marker_had=0
config_had=0
binary_next="$binary.next.$$"
marker_next="$marker.next.$$"
config_next="$config.next.$$"
binary_previous="$binary.previous.$$"
marker_previous="$marker.previous.$$"
config_previous="$config.previous.$$"
rollback() {
  [ "$transaction" -eq 1 ] || return 0
  rollback_failed=0
  rm -f "$binary" "$marker" "$config" || rollback_failed=1
  [ "$binary_had" -eq 0 ] || mv "$binary_previous" "$binary" || rollback_failed=1
  [ "$marker_had" -eq 0 ] || mv "$marker_previous" "$marker" || rollback_failed=1
  [ "$config_had" -eq 0 ] || mv "$config_previous" "$config" || rollback_failed=1
  transaction=0
  [ "$rollback_failed" -eq 0 ] || echo "OPENCODE_REXD_PHASE=install rollback failed" >&2
}
cleanup() {
  code=$?
  trap - EXIT HUP INT TERM
  [ "$committed" -eq 1 ] || rollback
  rm -f "$binary_next" "$marker_next" "$config_next" "$binary_previous" "$marker_previous" "$config_previous"
  [ -z "$temporary" ] || rm -rf "$temporary"
  [ "$owned" -eq 0 ] || rmdir "$lock" 2>/dev/null || true
  exit "$code"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
mkdir -p ${shellQuote(managedDirectory)} ${shellQuote(configDirectory)}
attempt=0
while ! mkdir "$lock" 2>/dev/null; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 100 ] || { echo "OPENCODE_REXD_PHASE=install lock timeout" >&2; exit 71; }
  sleep 0.1
done
owned=1
mkdir -p ${shellQuote(binaryDirectory)}
${stageBinary}cat >"$config_next" <<'OPENCODE_REXD_CONFIG' || { echo "OPENCODE_REXD_PHASE=install config staging failed" >&2; exit 77; }
${config}OPENCODE_REXD_CONFIG
chmod 0600 "$config_next" || { echo "OPENCODE_REXD_PHASE=install config staging failed" >&2; exit 77; }
"$binary_next" -h >/dev/null 2>&1 || { echo "OPENCODE_REXD_PHASE=install binary invalid" >&2; exit 78; }
transaction=1
if [ -e "$binary" ]; then mv "$binary" "$binary_previous" || { echo "OPENCODE_REXD_PHASE=install commit failed" >&2; exit 79; }; binary_had=1; fi
if [ -e "$marker" ]; then mv "$marker" "$marker_previous" || { echo "OPENCODE_REXD_PHASE=install commit failed" >&2; exit 79; }; marker_had=1; fi
if [ -e "$config" ]; then mv "$config" "$config_previous" || { echo "OPENCODE_REXD_PHASE=install commit failed" >&2; exit 79; }; config_had=1; fi
mv "$binary_next" "$binary" || { echo "OPENCODE_REXD_PHASE=install commit failed" >&2; exit 79; }
mv "$marker_next" "$marker" || { echo "OPENCODE_REXD_PHASE=install commit failed" >&2; exit 79; }
mv "$config_next" "$config" || { echo "OPENCODE_REXD_PHASE=install commit failed" >&2; exit 79; }
committed=1
transaction=0
rm -f "$binary_previous" "$marker_previous" "$config_previous"
${status}
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
