export * as SyncSecureStore from "./secure-store"

import path from "node:path"
import fs from "node:fs/promises"
import { dlopen, ptr, toArrayBuffer } from "bun:ffi"
import type { Pointer } from "bun:ffi"

export const SERVICE = "opencode-rexd-sync"
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

export interface MacosBackend {
  readonly get: (service: string, account: string) => string | undefined | Promise<string | undefined>
  readonly set: (service: string, account: string, secret: string) => void | Promise<void>
  readonly remove: (service: string, account: string) => void | Promise<void>
}

type CachedRead = {
  readonly generation: number
  readonly value: string | undefined
}

const macosReads = new WeakMap<MacosBackend, Map<string, CachedRead>>()
const macosPending = new WeakMap<MacosBackend, Map<string, Promise<string | undefined>>>()
const macosGenerations = new WeakMap<MacosBackend, Map<string, number>>()
const windowsReads = new WeakMap<Runner, Map<string, CachedRead>>()
const windowsPending = new WeakMap<Runner, Map<string, Promise<string | undefined>>>()
const windowsGenerations = new WeakMap<Runner, Map<string, number>>()

export class SecureStoreUnavailableError extends Error {
  override readonly name = "SyncSecureStore.UnavailableError"
}

export class SecureStoreOperationError extends Error {
  override readonly name = "SyncSecureStore.OperationError"
}

const MAX_APP_CREDENTIAL_BYTES = 4 * 1024
const MAX_APP_CREDENTIAL_FIELD = 512

/**
 * Parse the release-only credential envelope. Keeping this parser here makes
 * the deployment entrypoint use the same contract as the runtime reader.
 */
export function parseBaiduAppProvisioning(input: string): BaiduAppCredential {
  if (Buffer.byteLength(input, "utf8") > MAX_APP_CREDENTIAL_BYTES)
    throw new SecureStoreOperationError("Invalid Baidu app provisioning input")
  let parsed: unknown
  try {
    parsed = JSON.parse(input)
  } catch {
    throw new SecureStoreOperationError("Invalid Baidu app provisioning input")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new SecureStoreOperationError("Invalid Baidu app provisioning input")
  const value = parsed as Record<string, unknown>
  if (
    Object.keys(value).sort().join(",") !== "appKey,secretKey" ||
    typeof value.appKey !== "string" ||
    typeof value.secretKey !== "string" ||
    !validCredentialField(value.appKey) ||
    !validCredentialField(value.secretKey)
  )
    throw new SecureStoreOperationError("Invalid Baidu app provisioning input")
  return { appKey: value.appKey, secretKey: value.secretKey }
}

/** Atomically replace the product OAuth credential, restoring the old value on failure. */
export async function provisionBaiduApp(store: Store, input: string) {
  const credential = parseBaiduAppProvisioning(input)
  const previous = await store.get(BAIDU_APP_ACCOUNT)
  const encoded = JSON.stringify(credential)
  try {
    await store.set(BAIDU_APP_ACCOUNT, encoded)
    const verified = await store.get(BAIDU_APP_ACCOUNT)
    if (verified !== encoded) throw new SecureStoreOperationError("Baidu app provisioning verification failed")
  } catch {
    try {
      if (previous === undefined) {
        await store.remove(BAIDU_APP_ACCOUNT)
        if ((await store.get(BAIDU_APP_ACCOUNT)) !== undefined) throw new Error("rollback verification")
      } else {
        await store.set(BAIDU_APP_ACCOUNT, previous)
        if ((await store.get(BAIDU_APP_ACCOUNT)) !== previous) throw new Error("rollback verification")
      }
    } catch {
      throw new SecureStoreOperationError("Baidu app provisioning failed and rollback could not be verified")
    }
    throw new SecureStoreOperationError("Baidu app provisioning failed; previous credential was restored")
  }
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

export async function readProvisionedBaiduApp(store: Store) {
  const value = await store.get(BAIDU_APP_ACCOUNT)
  if (!value) return
  const parsed = JSON.parse(value) as BaiduAppCredential
  if (!parsed?.appKey || !parsed.secretKey || /[\r\n\0]/.test(parsed.appKey) || /[\r\n\0]/.test(parsed.secretKey))
    throw new SecureStoreOperationError("Invalid provisioned Baidu app credential")
  return parsed
}

function validCredentialField(value: string) {
  return value.length > 0 && value.length <= MAX_APP_CREDENTIAL_FIELD && !/[\r\n\0]/.test(value)
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
  if (platform === "darwin") return macos(service)
  const procVersion = options.procVersion ?? (await fs.readFile("/proc/version", "utf8").catch(() => ""))
  if (platform === "linux" && /microsoft|wsl/i.test(procVersion))
    return windowsVault(runner, options.findInterop ?? findWslInterop, service)
  throw new SecureStoreUnavailableError("Sync secure storage requires macOS Keychain or WSL PasswordVault")
}

export function macos(service = SERVICE, backend: MacosBackend = macosKeychain): Store {
  const reads = cacheFor(macosReads, backend)
  const pending = cacheFor(macosPending, backend)
  const generations = cacheFor(macosGenerations, backend)
  const key = (account: string) => `${service}\0${account}`
  return {
    platform: "macos-keychain",
    async get(account) {
      validateAccount(account)
      const id = key(account)
      const generation = generations.get(id) ?? 0
      const cached = reads.get(id)
      if (cached?.generation === generation) return cached.value
      const active = pending.get(id)
      if (active) return active
      const operation = Promise.resolve(backend.get(service, account)).then((value) => {
        if ((generations.get(id) ?? 0) === generation) reads.set(id, { generation, value })
        return value
      })
      pending.set(id, operation)
      try {
        return await operation
      } finally {
        if (pending.get(id) === operation) pending.delete(id)
      }
    },
    async set(account, secret) {
      validateAccount(account)
      const id = key(account)
      await backend.set(service, account, secret)
      const generation = (generations.get(id) ?? 0) + 1
      generations.set(id, generation)
      reads.set(id, { generation, value: secret })
    },
    async remove(account) {
      validateAccount(account)
      const id = key(account)
      await backend.remove(service, account)
      const generation = (generations.get(id) ?? 0) + 1
      generations.set(id, generation)
      reads.set(id, { generation, value: undefined })
    },
  }
}

function cacheFor<K extends object, V>(cache: WeakMap<K, Map<string, V>>, owner: K) {
  const existing = cache.get(owner)
  if (existing) return existing
  const created = new Map<string, V>()
  cache.set(owner, created)
  return created
}

const macosKeychain: MacosBackend = {
  get(service, account) {
    const native = openMacosKeychain()
    const serviceBytes = Buffer.from(service, "utf8")
    const accountBytes = Buffer.from(account, "utf8")
    const passwordLength = new Uint32Array(1)
    const passwordData = new BigUint64Array(1)
    try {
      const status = native.security.symbols.SecKeychainFindGenericPassword(
        null,
        serviceBytes.byteLength,
        ptr(serviceBytes),
        accountBytes.byteLength,
        ptr(accountBytes),
        ptr(passwordLength),
        ptr(passwordData),
        null,
      )
      if (status === -25300) return undefined
      ensureKeychain(status)
      const reference = Number(passwordData[0]) as Pointer
      try {
        if (passwordLength[0] === 0) return ""
        return Buffer.from(toArrayBuffer(reference, 0, passwordLength[0])).toString("utf8")
      } finally {
        ensureKeychain(native.security.symbols.SecKeychainItemFreeContent(null, reference))
      }
    } finally {
      native.close()
    }
  },
  set(service, account, secret) {
    const native = openMacosKeychain()
    const serviceBytes = Buffer.from(service, "utf8")
    const accountBytes = Buffer.from(account, "utf8")
    const secretBytes = Buffer.from(secret, "utf8")
    const item = new BigUint64Array(1)

    try {
      const found = native.security.symbols.SecKeychainFindGenericPassword(
        null,
        serviceBytes.byteLength,
        ptr(serviceBytes),
        accountBytes.byteLength,
        ptr(accountBytes),
        null,
        null,
        ptr(item),
      )
      if (found === -25300) {
        ensureKeychain(
          native.security.symbols.SecKeychainAddGenericPassword(
            null,
            serviceBytes.byteLength,
            ptr(serviceBytes),
            accountBytes.byteLength,
            ptr(accountBytes),
            secretBytes.byteLength,
            ptr(secretBytes),
            null,
          ),
        )
        return
      }
      ensureKeychain(found)
      const reference = Number(item[0]) as Pointer
      try {
        ensureKeychain(
          native.security.symbols.SecKeychainItemModifyAttributesAndData(
            reference,
            null,
            secretBytes.byteLength,
            ptr(secretBytes),
          ),
        )
      } finally {
        native.coreFoundation.symbols.CFRelease(reference)
      }
    } finally {
      native.close()
    }
  },
  remove(service, account) {
    const native = openMacosKeychain()
    const serviceBytes = Buffer.from(service, "utf8")
    const accountBytes = Buffer.from(account, "utf8")
    const item = new BigUint64Array(1)
    try {
      const found = native.security.symbols.SecKeychainFindGenericPassword(
        null,
        serviceBytes.byteLength,
        ptr(serviceBytes),
        accountBytes.byteLength,
        ptr(accountBytes),
        null,
        null,
        ptr(item),
      )
      if (found === -25300) return
      ensureKeychain(found)
      const reference = Number(item[0]) as Pointer
      try {
        ensureKeychain(native.security.symbols.SecKeychainItemDelete(reference))
      } finally {
        native.coreFoundation.symbols.CFRelease(reference)
      }
    } finally {
      native.close()
    }
  },
}

function openMacosKeychain() {
  const security = dlopen("/System/Library/Frameworks/Security.framework/Security", {
    SecKeychainFindGenericPassword: {
      args: ["ptr", "u32", "ptr", "u32", "ptr", "ptr", "ptr", "ptr"],
      returns: "i32",
    },
    SecKeychainItemModifyAttributesAndData: { args: ["ptr", "ptr", "u32", "ptr"], returns: "i32" },
    SecKeychainAddGenericPassword: {
      args: ["ptr", "u32", "ptr", "u32", "ptr", "u32", "ptr", "ptr"],
      returns: "i32",
    },
    SecKeychainItemFreeContent: { args: ["ptr", "ptr"], returns: "i32" },
    SecKeychainItemDelete: { args: ["ptr"], returns: "i32" },
  })
  const coreFoundation = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
    CFRelease: { args: ["ptr"], returns: "void" },
  })
  return {
    security,
    coreFoundation,
    close() {
      coreFoundation.close()
      security.close()
    },
  }
}

export function windowsVault(runner: Runner, findInterop: () => Promise<string | undefined>, service = SERVICE): Store {
  const reads = cacheFor(windowsReads, runner)
  const pending = cacheFor(windowsPending, runner)
  const generations = cacheFor(windowsGenerations, runner)
  const key = (account: string) => `${service}\0${account}`
  const powershell = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
  const invoke = async (operation: "get" | "set" | "remove", account: string, secret?: string) => {
    validateAccount(account)
    const input = JSON.stringify({ operation, resource: service, account, secret })
    const inherited = process.env.WSL_INTEROP
    const discovered = await findInterop()
    const selected = discovered ?? inherited
    const command = [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", script]
    const result = await runner(command, input, selected && selected !== inherited ? { WSL_INTEROP: selected } : {})
    if (result.exitCode === 3) return undefined
    if (result.exitCode === 0) return operation === "get" ? trimOneNewline(result.stdout) : undefined

    // A tmux process can outlive the WSL login session that supplied its
    // inherited socket. Retry only when discovery proves that the transport
    // changed; other PasswordVault failures have unknown side effects.
    const recovered = await findInterop()
    if (!recovered || recovered === selected) {
      ensure(result)
      return undefined
    }
    const retried = await runner(command, input, { WSL_INTEROP: recovered })
    if (retried.exitCode === 3) return undefined
    ensure(retried)
    return operation === "get" ? trimOneNewline(retried.stdout) : undefined
  }
  return {
    platform: "windows-password-vault",
    async get(account) {
      validateAccount(account)
      const id = key(account)
      const generation = generations.get(id) ?? 0
      const cached = reads.get(id)
      if (cached?.generation === generation) return cached.value
      const active = pending.get(id)
      if (active) return active
      const operation = invoke("get", account).then((value) => {
        if ((generations.get(id) ?? 0) === generation) reads.set(id, { generation, value })
        return value
      })
      pending.set(id, operation)
      try {
        return await operation
      } finally {
        if (pending.get(id) === operation) pending.delete(id)
      }
    },
    async set(account, secret) {
      const id = key(account)
      await invoke("set", account, secret)
      const generation = (generations.get(id) ?? 0) + 1
      generations.set(id, generation)
      reads.set(id, { generation, value: secret })
    },
    async remove(account) {
      const id = key(account)
      await invoke("remove", account)
      const generation = (generations.get(id) ?? 0) + 1
      generations.set(id, generation)
      reads.set(id, { generation, value: undefined })
    },
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

function ensureKeychain(status: number) {
  if (status === 0) return
  throw new SecureStoreOperationError(`Secure-store Keychain operation failed with status ${status}`)
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
