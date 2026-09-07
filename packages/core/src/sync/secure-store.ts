export * as SyncSecureStore from "./secure-store"

import path from "node:path"
import fs from "node:fs/promises"

export const SERVICE = "opencode-rexd-sync"
export const LEGACY_BAIDU_SERVICE = "opencode-rexd-baidu"
export const BAIDU_APP_ACCOUNT = "baidu:app"

export type BaiduAppCredential = {
  readonly appKey: string
  readonly secretKey: string
}

export interface Store {
  readonly platform: "macos-keychain" | "windows-password-vault"
  readonly get: (account: string) => Promise<string | undefined>
  readonly set: (account: string, secret: string) => Promise<void>
  readonly remove: (account: string) => Promise<void>
}

export interface CommandResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type Runner = (
  command: readonly string[],
  stdin?: string,
  env?: Record<string, string>,
) => Promise<CommandResult>

export class SecureStoreUnavailableError extends Error {
  override readonly name = "SyncSecureStore.UnavailableError"
}

export class SecureStoreOperationError extends Error {
  override readonly name = "SyncSecureStore.OperationError"
}

export async function detect(
  options: {
    readonly platform?: NodeJS.Platform
    readonly runner?: Runner
    readonly procVersion?: string
    readonly findInterop?: () => Promise<string | undefined>
  } = {},
): Promise<Store> {
  return detectService(SERVICE, options)
}

/** @deprecated Test-only bridge until the legacy SyncSetup flow is removed. */
export async function detectLegacyBaidu(
  options: {
    readonly platform?: NodeJS.Platform
    readonly runner?: Runner
    readonly procVersion?: string
    readonly findInterop?: () => Promise<string | undefined>
  } = {},
): Promise<Store> {
  return detectService(LEGACY_BAIDU_SERVICE, options)
}

export async function readProvisionedBaiduApp(store: Store) {
  const value = await store.get(BAIDU_APP_ACCOUNT)
  if (!value) return
  const parsed = JSON.parse(value) as BaiduAppCredential
  if (!parsed?.appKey || !parsed.secretKey || /[\r\n\0]/.test(parsed.appKey) || /[\r\n\0]/.test(parsed.secretKey))
    throw new SecureStoreOperationError("Invalid provisioned Baidu app credential")
  return parsed
}

async function detectService(
  service: string,
  options: {
    readonly platform?: NodeJS.Platform
    readonly runner?: Runner
    readonly procVersion?: string
    readonly findInterop?: () => Promise<string | undefined>
  },
): Promise<Store> {
  const platform = options.platform ?? process.platform
  const runner = options.runner ?? run
  if (platform === "darwin") return macos(runner, service)
  const procVersion = options.procVersion ?? (await fs.readFile("/proc/version", "utf8").catch(() => ""))
  if (platform === "linux" && /microsoft|wsl/i.test(procVersion))
    return windowsVault(runner, options.findInterop ?? findWslInterop, service)
  throw new SecureStoreUnavailableError("Sync secure storage requires macOS Keychain or WSL PasswordVault")
}

export function macos(runner: Runner, service = SERVICE): Store {
  const security = "/usr/bin/security"
  return {
    platform: "macos-keychain",
    async get(account) {
      validateAccount(account)
      const result = await runner([security, "find-generic-password", "-a", account, "-s", service, "-w"])
      if (result.exitCode === 44) return undefined
      ensure(result)
      return trimOneNewline(result.stdout)
    },
    async set(account, secret) {
      validateAccount(account)
      // macOS security(1) has no non-interactive stdin secret option. The
      // argument is passed directly to spawn (never through a shell) and is
      // never logged or retained by this service.
      ensure(await runner([security, "add-generic-password", "-U", "-a", account, "-s", service, "-w", secret]))
    },
    async remove(account) {
      validateAccount(account)
      const result = await runner([security, "delete-generic-password", "-a", account, "-s", service])
      if (result.exitCode !== 0 && result.exitCode !== 44) ensure(result)
    },
  }
}

export function windowsVault(runner: Runner, findInterop: () => Promise<string | undefined>, service = SERVICE): Store {
  const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  const invoke = async (operation: "get" | "set" | "remove", account: string, secret?: string) => {
    validateAccount(account)
    const env: Record<string, string> = {}
    if (!process.env.WSL_INTEROP) {
      const interop = await findInterop()
      if (interop) env.WSL_INTEROP = interop
    }
    const input = JSON.stringify({ operation, resource: service, account, secret })
    const result = await runner(
      [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script],
      input,
      env,
    )
    if (result.exitCode === 3) return undefined
    ensure(result)
    return operation === "get" ? trimOneNewline(result.stdout) : undefined
  }
  return {
    platform: "windows-password-vault",
    get: (account) => invoke("get", account),
    set: (account, secret) => invoke("set", account, secret).then(() => undefined),
    remove: (account) => invoke("remove", account).then(() => undefined),
  }
}

async function run(command: readonly string[], stdin?: string, extraEnv: Record<string, string> = {}) {
  const child = Bun.spawn([...command], {
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...extraEnv },
  })
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  return { exitCode, stdout, stderr }
}

async function findWslInterop() {
  const entries = await fs.readdir("/run/WSL", { withFileTypes: true }).catch(() => [])
  const sockets = entries
    .filter((entry) => entry.isSocket() && entry.name.endsWith("_interop"))
    .map((entry) => path.join("/run/WSL", entry.name))
  const states = await Promise.all(
    sockets.map(async (file) => ({ file, time: (await fs.stat(file).catch(() => undefined))?.mtimeMs ?? 0 })),
  )
  return states.sort((left, right) => right.time - left.time)[0]?.file
}

function validateAccount(account: string) {
  if (!account || /[\r\n\0]/.test(account)) throw new SecureStoreOperationError("Invalid secure-store account")
}

function ensure(result: CommandResult) {
  if (result.exitCode === 0) return
  // stderr is intentionally not included: platform tooling may echo secrets.
  throw new SecureStoreOperationError(`Secure-store command failed with exit code ${result.exitCode}`)
}

function trimOneNewline(value: string) {
  return value.replace(/\r?\n$/, "")
}

const source = String.raw`
$ErrorActionPreference = 'Stop'
$inputJson = [Console]::In.ReadToEnd() | ConvertFrom-Json
[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null
$vault = New-Object Windows.Security.Credentials.PasswordVault
$resource = [string]$inputJson.resource
$account = [string]$inputJson.account
try {
  if ($inputJson.operation -eq 'get') {
    $credential = $vault.Retrieve($resource, $account)
    $credential.RetrievePassword()
    [Console]::Out.Write($credential.Password)
  } elseif ($inputJson.operation -eq 'set') {
    try { $old = $vault.Retrieve($resource, $account); $vault.Remove($old) } catch {}
    $vault.Add((New-Object Windows.Security.Credentials.PasswordCredential($resource, $account, [string]$inputJson.secret)))
  } elseif ($inputJson.operation -eq 'remove') {
    try { $old = $vault.Retrieve($resource, $account); $vault.Remove($old) } catch [System.Exception] { exit 0 }
  } else { exit 2 }
} catch [System.Exception] {
  if ($inputJson.operation -eq 'get') { exit 3 }
  exit 1
}`

const script = Buffer.from(source, "utf16le").toString("base64")
