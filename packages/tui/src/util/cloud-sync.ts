import { createHash, randomUUID } from "crypto"
import { spawn } from "child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs"
import path from "path"

export type CloudSyncConfig = {
  version: 1
  provider: "baidu"
  deviceID: string
  deviceName: string
  enabled: boolean
  intervalSeconds: number
}

export type SyncEvent = {
  id: string
  aggregateID: string
  seq: number
  type: string
  data: Record<string, unknown>
}

export type SyncPack = {
  version: 1
  deviceID: string
  generation: number
  createdAt: number
  events: SyncEvent[]
}

export type DeviceManifest = {
  version: 1
  deviceID: string
  generation: number
  pack: string
  sha256: string
  eventCount: number
  updatedAt: number
  heads: Record<string, number>
}

export type BaiduCredential = {
  appKey: string
  secretKey: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

export function syncRoot(home: string) {
  return path.join(home, ".config", "opencode", "cloud-sync")
}

export function readCloudSyncConfig(home: string) {
  const file = path.join(syncRoot(home), "config.json")
  if (!existsSync(file)) return
  return JSON.parse(readFileSync(file, "utf8")) as CloudSyncConfig
}

export function configureCloudSync(home: string, input: { deviceName: string; enabled?: boolean }) {
  const previous = readCloudSyncConfig(home)
  const config: CloudSyncConfig = {
    version: 1,
    provider: "baidu",
    deviceID: previous?.deviceID ?? randomUUID(),
    deviceName: input.deviceName.trim() || "OpenCode device",
    enabled: input.enabled ?? previous?.enabled ?? false,
    intervalSeconds: previous?.intervalSeconds ?? 30,
  }
  writeAtomic(path.join(syncRoot(home), "config.json"), config)
  return config
}

export function baiduAuthorizationUrl(appKey: string) {
  const url = new URL("https://openapi.baidu.com/oauth/2.0/authorize")
  url.searchParams.set("response_type", "code")
  url.searchParams.set("client_id", appKey)
  url.searchParams.set("redirect_uri", "oob")
  url.searchParams.set("scope", "basic,netdisk")
  url.searchParams.set("display", "popup")
  url.searchParams.set("force_login", "1")
  return url.toString()
}

export async function exchangeBaiduAuthorizationCode(input: { appKey: string; secretKey: string; code: string }) {
  const url = new URL("https://openapi.baidu.com/oauth/2.0/token")
  url.searchParams.set("grant_type", "authorization_code")
  url.searchParams.set("code", input.code.trim())
  url.searchParams.set("client_id", input.appKey.trim())
  url.searchParams.set("client_secret", input.secretKey.trim())
  url.searchParams.set("redirect_uri", "oob")
  const response = await fetch(url)
  const result = (await response.json()) as Record<string, unknown>
  if (!response.ok || typeof result.access_token !== "string" || typeof result.refresh_token !== "string") {
    throw new Error(String(result.error_description ?? result.error ?? `Baidu OAuth failed (${response.status})`))
  }
  return {
    appKey: input.appKey.trim(),
    secretKey: input.secretKey.trim(),
    accessToken: result.access_token,
    refreshToken: result.refresh_token,
    expiresAt: Date.now() + Number(result.expires_in ?? 2_592_000) * 1000,
  } satisfies BaiduCredential
}

export async function saveBaiduCredential(deviceID: string, credential: BaiduCredential) {
  if (process.platform !== "darwin") throw new Error("Secure credential storage is not implemented on this platform yet")
  await runProcess([
    "security",
    "add-generic-password",
    "-U",
    "-a",
    deviceID,
    "-s",
    "opencode-rexd-baidu",
    "-w",
  ], false, JSON.stringify(credential) + "\n")
}

export async function readBaiduCredential(deviceID: string) {
  if (process.platform !== "darwin") return
  const result = await runProcess(
    ["security", "find-generic-password", "-a", deviceID, "-s", "opencode-rexd-baidu", "-w"],
    true,
  )
  if (!result) return
  return JSON.parse(result.trim()) as BaiduCredential
}

export function encodeSyncPack(pack: SyncPack) {
  const json = JSON.stringify(pack)
  return Bun.gzipSync(Buffer.from(json))
}

export function decodeSyncPack(input: Uint8Array) {
  const value = JSON.parse(Buffer.from(Bun.gunzipSync(new Uint8Array(input))).toString("utf8")) as SyncPack
  if (value.version !== 1 || !value.deviceID || !Array.isArray(value.events)) throw new Error("Invalid sync pack")
  return value
}

export function createDeviceManifest(pack: SyncPack, filename = "current.pack.gz"): DeviceManifest {
  const encoded = encodeSyncPack(pack)
  const heads = Object.fromEntries(
    Object.entries(
      pack.events.reduce<Record<string, number>>((result, event) => {
        result[event.aggregateID] = Math.max(result[event.aggregateID] ?? -1, event.seq)
        return result
      }, {}),
    ).sort(([left], [right]) => left.localeCompare(right)),
  )
  return {
    version: 1,
    deviceID: pack.deviceID,
    generation: pack.generation,
    pack: filename,
    sha256: createHash("sha256").update(encoded).digest("hex"),
    eventCount: pack.events.length,
    updatedAt: pack.createdAt,
    heads,
  }
}

export function mergeSyncEvents(packs: SyncPack[]) {
  const unique = new Map<string, SyncEvent>()
  packs
    .flatMap((pack) => pack.events)
    .sort((left, right) => left.aggregateID.localeCompare(right.aggregateID) || left.seq - right.seq)
    .forEach((event) => {
      const key = `${event.aggregateID}:${event.seq}`
      const previous = unique.get(key)
      if (previous && previous.id !== event.id) {
        throw new Error(`Sync conflict at ${event.aggregateID} revision ${event.seq}`)
      }
      unique.set(key, event)
    })
  return [...unique.values()]
}

function writeAtomic(file: string, value: unknown) {
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 })
  renameSync(temporary, file)
}

function runProcess(args: string[], allowFailure = false, input?: string) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), { stdio: [input ? "pipe" : "ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => (stdout += String(chunk)))
    child.stderr?.on("data", (chunk) => (stderr += String(chunk)))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve(stdout)
      else if (allowFailure) resolve("")
      else reject(new Error(stderr.trim() || `${args[0]} exited with code ${code}`))
    })
    if (input) child.stdin?.end(input)
  })
}
