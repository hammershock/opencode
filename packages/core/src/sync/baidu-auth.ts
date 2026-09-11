export * as BaiduAuth from "./baidu-auth"

import { BaiduSyncProvider } from "./baidu-provider"
import { SyncSecureStore } from "./secure-store"

const ACCOUNT_API = "https://pan.baidu.com/rest/2.0/xpan/nas"
const MAX_ATTEMPT_AGE = 15 * 60 * 1_000
export const MISSING_APP_MESSAGE =
  "Baidu Netdisk is not enabled in this build. Connect your Baidu application in OpenCode Transit Sync settings."

export type Attempt = {
  readonly id: string
  readonly state: string
  readonly deviceID: string
  readonly redirectURI: string
  readonly completion: "loopback" | "manual"
  readonly createdAt: number
}

export type AccountIdentity = {
  readonly id: string
  readonly displayName: string
  readonly maskedDisplay: string
}

export type BeginResult = {
  readonly attemptID: string
  readonly authorizationURL: string
  readonly completion: Attempt["completion"]
}

export class AuthError extends Error {
  override readonly name = "BaiduAuth.Error"

  constructor(
    readonly kind:
      | "missing-app"
      | "missing-attempt"
      | "expired-attempt"
      | "invalid-callback"
      | "provider"
      | "account-mismatch"
      | "storage",
  ) {
    super(kind === "missing-app" ? MISSING_APP_MESSAGE : `Baidu authentication failed: ${kind}`)
  }
}

export function pendingAccount(deviceID: string) {
  validateDevice(deviceID)
  return `baidu:oauth-pending:${deviceID}`
}

export async function begin(input: {
  readonly store: SyncSecureStore.Store
  readonly deviceID: string
  readonly redirectURI: string
  readonly completion: Attempt["completion"]
  readonly now?: () => number
  readonly randomUUID?: () => string
}) {
  validateRedirect(input.redirectURI, input.completion)
  const app = await SyncSecureStore.readProvisionedBaiduApp(input.store).catch(() => {
    throw new AuthError("storage")
  })
  if (!app) throw new AuthError("missing-app")
  const randomUUID = input.randomUUID ?? (() => crypto.randomUUID())
  const attempt: Attempt = {
    id: randomUUID(),
    state: randomUUID(),
    deviceID: input.deviceID,
    redirectURI: input.redirectURI,
    completion: input.completion,
    createdAt: (input.now ?? Date.now)(),
  }
  await input.store.set(pendingAccount(input.deviceID), JSON.stringify(attempt)).catch(() => {
    throw new AuthError("storage")
  })
  return {
    attemptID: attempt.id,
    authorizationURL: BaiduSyncProvider.authorizationURL(app.appKey, attempt.redirectURI, attempt.state),
    completion: attempt.completion,
  } satisfies BeginResult
}

export async function complete(input: CompletionInput) {
  return finish(input, false)
}

export async function switchAccount(input: CompletionInput) {
  return finish(input, true)
}

export function loopbackCode(callbackURL: string, attempt: Attempt) {
  const url = new URL(callbackURL)
  const redirect = new URL(attempt.redirectURI)
  if (
    attempt.completion !== "loopback" ||
    !isLoopback(url) ||
    url.origin !== redirect.origin ||
    url.pathname !== redirect.pathname ||
    url.searchParams.get("state") !== attempt.state
  )
    throw new AuthError("invalid-callback")
  const code = url.searchParams.get("code")
  if (!code || /[\r\n\0]/.test(code)) throw new AuthError("invalid-callback")
  return code
}

export function manualCode(value: string) {
  const trimmed = value.trim()
  if (!trimmed || /[\r\n\0]/.test(trimmed)) throw new AuthError("invalid-callback")
  return trimmed
}

export async function pending(store: SyncSecureStore.Store, deviceID: string, now: () => number = Date.now) {
  const value = await store.get(pendingAccount(deviceID)).catch(() => {
    throw new AuthError("storage")
  })
  if (!value) return
  const attempt = parseAttempt(value, deviceID)
  if (now() - attempt.createdAt <= MAX_ATTEMPT_AGE) return attempt
  await store.remove(pendingAccount(deviceID)).catch(() => undefined)
  throw new AuthError("expired-attempt")
}

export async function account(store: SyncSecureStore.Store, deviceID: string) {
  const credential = await BaiduSyncProvider.readCredential(store, deviceID).catch(() => {
    throw new AuthError("storage")
  })
  return credential?.account
}

type CompletionInput = {
  readonly store: SyncSecureStore.Store
  readonly deviceID: string
  readonly attemptID: string
  readonly response:
    | { readonly type: "loopback"; readonly callbackURL: string }
    | { readonly type: "manual"; readonly code: string }
  readonly request?: BaiduSyncProvider.Request
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
}

async function finish(input: CompletionInput, allowSwitch: boolean) {
  const now = input.now ?? Date.now
  const attempt = await pending(input.store, input.deviceID, now)
  if (!attempt || attempt.id !== input.attemptID) throw new AuthError("missing-attempt")
  if (input.response.type !== attempt.completion) throw new AuthError("invalid-callback")
  const app = await SyncSecureStore.readProvisionedBaiduApp(input.store).catch(() => {
    throw new AuthError("storage")
  })
  if (!app) throw new AuthError("missing-app")
  const credential = await BaiduSyncProvider.exchangeCode({
    appKey: app.appKey,
    secretKey: app.secretKey,
    code:
      input.response.type === "loopback"
        ? loopbackCode(input.response.callbackURL, attempt)
        : manualCode(input.response.code),
    redirectURI: attempt.redirectURI,
    request: input.request,
    now,
    signal: input.signal,
    requestTimeoutMs: input.requestTimeoutMs,
  }).catch(() => {
    throw new AuthError("provider")
  })
  const identity = await identify(
    credential,
    BaiduSyncProvider.boundedRequest(input.request ?? fetch, input.requestTimeoutMs),
    input.signal,
  ).catch(() => {
    throw new AuthError("provider")
  })
  const current = await account(input.store, input.deviceID)
  if (current && current.id !== identity.id && !allowSwitch) throw new AuthError("account-mismatch")
  await BaiduSyncProvider.saveCredential(input.store, input.deviceID, { ...credential, account: identity }).catch(
    () => {
      throw new AuthError("storage")
    },
  )
  await input.store.remove(pendingAccount(input.deviceID)).catch(() => {
    throw new AuthError("storage")
  })
  return identity
}

async function identify(
  credential: BaiduSyncProvider.Credential,
  request: BaiduSyncProvider.Request,
  signal?: AbortSignal,
) {
  const url = new URL(ACCOUNT_API)
  url.search = new URLSearchParams({ method: "uinfo", access_token: credential.accessToken }).toString()
  const response = await request(url, { signal })
  const body = (await response.json().catch(() => undefined)) as Record<string, unknown> | undefined
  if (!response.ok || !body || Number(body.errno ?? 0) !== 0) throw new AuthError("provider")
  const rawID = body.uk
  const id = typeof rawID === "number" ? String(rawID) : typeof rawID === "string" ? rawID : ""
  const displayName =
    typeof body.baidu_name === "string" && body.baidu_name
      ? body.baidu_name
      : typeof body.netdisk_name === "string" && body.netdisk_name
        ? body.netdisk_name
        : "Baidu account"
  if (!id || /[\r\n\0]/.test(id) || /[\r\n\0]/.test(displayName)) throw new AuthError("provider")
  return { id, displayName, maskedDisplay: `${mask(displayName)} · ${maskID(id)}` } satisfies AccountIdentity
}

function parseAttempt(value: string, deviceID: string) {
  const parsed = JSON.parse(value) as Attempt
  if (
    !parsed?.id ||
    !parsed.state ||
    parsed.deviceID !== deviceID ||
    !parsed.redirectURI ||
    (parsed.completion !== "loopback" && parsed.completion !== "manual") ||
    !Number.isFinite(parsed.createdAt)
  )
    throw new AuthError("storage")
  return parsed
}

function validateDevice(deviceID: string) {
  if (!deviceID || /[\r\n\0]/.test(deviceID)) throw new AuthError("storage")
}

function validateRedirect(value: string, completion: Attempt["completion"]) {
  // Baidu's installed-app authorization flow uses the literal `oob` redirect
  // to display a copyable authorization code. Keep it as the only non-URL
  // manual fallback; loopback attempts remain origin-bound below.
  if (completion === "manual" && value === "oob") return
  const url = new URL(value)
  if (completion === "loopback" && !isLoopback(url)) throw new AuthError("invalid-callback")
  if (completion === "manual" && url.protocol !== "https:") throw new AuthError("invalid-callback")
}

function isLoopback(url: URL) {
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost")
  )
}

function mask(value: string) {
  const characters = Array.from(value)
  if (characters.length < 2) return "•"
  return `${characters[0]}${"•".repeat(Math.min(4, characters.length - 1))}`
}

function maskID(value: string) {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`
}
