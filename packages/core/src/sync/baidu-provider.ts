import { createHash } from "node:crypto"
import path from "node:path"
import { SyncProvider } from "./provider"
import { SyncSecureStore } from "./secure-store"

export * as BaiduSyncProvider from "./baidu-provider"

const FILE_API = "https://pan.baidu.com/rest/2.0/xpan/file"
const MEDIA_API = "https://pan.baidu.com/rest/2.0/xpan/multimedia"
const UPLOAD_API = "https://d.pcs.baidu.com/rest/2.0/pcs/superfile2"
const TOKEN_API = "https://openapi.baidu.com/oauth/2.0/token"
const PART_SIZE = 4 * 1024 * 1024
export const REQUEST_TIMEOUT_MS = 30_000

export type Credential = {
  readonly appKey: string
  readonly secretKey: string
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly account?: {
    readonly id: string
    readonly displayName: string
    readonly maskedDisplay: string
  }
}

export type Request = (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>

export function credentialAccount(deviceID: string) {
  if (!deviceID || /[\r\n\0]/.test(deviceID)) throw new Error("Invalid sync device ID")
  return `baidu:${deviceID}`
}

export async function saveCredential(store: SyncSecureStore.Store, deviceID: string, credential: Credential) {
  validateCredential(credential)
  await store.set(credentialAccount(deviceID), JSON.stringify(credential))
}

export async function readCredential(store: SyncSecureStore.Store, deviceID: string) {
  const value = await store.get(credentialAccount(deviceID))
  if (!value) return
  return parseCredential(value)
}

export async function exchangeCode(input: {
  readonly appKey: string
  readonly secretKey: string
  readonly code: string
  readonly redirectURI: string
  readonly request?: Request
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
}) {
  return token(
    {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.appKey,
      client_secret: input.secretKey,
      redirect_uri: input.redirectURI,
    },
    input.appKey,
    input.secretKey,
    boundedRequest(input.request ?? fetch, input.requestTimeoutMs),
    input.now ?? Date.now,
    input.signal,
    undefined,
  ).catch((cause) => {
    throw classify("stat", cause)
  })
}

export async function refreshCredential(input: {
  readonly credential: Credential
  readonly request?: Request
  readonly now?: () => number
  readonly signal?: AbortSignal
  readonly requestTimeoutMs?: number
}) {
  return token(
    {
      grant_type: "refresh_token",
      refresh_token: input.credential.refreshToken,
      client_id: input.credential.appKey,
      client_secret: input.credential.secretKey,
    },
    input.credential.appKey,
    input.credential.secretKey,
    boundedRequest(input.request ?? fetch, input.requestTimeoutMs),
    input.now ?? Date.now,
    input.signal,
    input.credential.refreshToken,
  ).catch((cause) => {
    throw classify("stat", cause)
  })
}

export function authorizationURL(appKey: string, redirectURI: string, state?: string) {
  const url = new URL("https://openapi.baidu.com/oauth/2.0/authorize")
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: appKey,
    redirect_uri: redirectURI,
    scope: "basic,netdisk",
    ...(state ? { state } : {}),
  }).toString()
  return url.toString()
}

export function adapter(input: {
  readonly store: SyncSecureStore.Store
  readonly deviceID: string
  readonly root: string
  readonly request?: Request
  readonly now?: () => number
  readonly sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>
  readonly requestTimeoutMs?: number
}): SyncProvider.Adapter {
  const request = boundedRequest(input.request ?? fetch, input.requestTimeoutMs)
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? delay
  const root = normalizeRoot(input.root)
  const directories = new Map<string, Promise<void>>()

  const credential = async (signal?: AbortSignal, force = false) => {
    signal?.throwIfAborted()
    const current = await readCredential(input.store, input.deviceID)
    if (!current) throw error("stat", "unauthenticated", false)
    if (!force && current.expiresAt > now() + 60_000) return current
    const refreshed = await token(
      {
        grant_type: "refresh_token",
        refresh_token: current.refreshToken,
        client_id: current.appKey,
        client_secret: current.secretKey,
      },
      current.appKey,
      current.secretKey,
      request,
      now,
      signal,
      current.refreshToken,
    ).catch((cause) => {
      throw classify("stat", cause)
    })
    await saveCredential(input.store, input.deviceID, refreshed)
    return refreshed
  }

  const call = async <A>(
    operation: SyncProvider.ProviderError["operation"],
    run: (credential: Credential) => Promise<A>,
    signal?: AbortSignal,
  ) => {
    let auth = await credential(signal)
    for (let attempt = 0; attempt < 4; attempt++) {
      signal?.throwIfAborted()
      try {
        return await run(auth)
      } catch (cause) {
        const failure = classify(operation, cause)
        if (failure.kind === "unauthenticated" && attempt === 0) {
          auth = await credential(signal, true)
          continue
        }
        if (!failure.retryable || attempt === 3) throw failure
        await sleep(failure.retryAfter ?? Math.min(4_000, 250 * 2 ** attempt), signal)
      }
    }
    throw error(operation, "provider", false)
  }

  const stat = async (object: string, signal?: AbortSignal) => {
    const remote = remotePath(root, object)
    const listed = await call(
      "stat",
      (auth) => listDirectory(auth, path.posix.dirname(remote), request, signal),
      signal,
    ).catch((cause) => {
      if (cause instanceof SyncProvider.ProviderError && cause.kind === "not-found") return []
      throw cause
    })
    const found = listed.find((item) => item.remotePath === remote)?.info
    return found ? { ...found, path: object } : undefined
  }

  const download = async (object: string, version?: string, signal?: AbortSignal) => {
    const remote = remotePath(root, object)
    const before = await stat(object, signal)
    if (!before) throw error("download", "not-found", false)
    if (version && before.version !== version) throw error("download", "conflict", false)
    const fsID = Number(before.version.split(":", 1)[0])
    const bytes = await call(
      "download",
      async (auth) => {
        const url = endpoint(MEDIA_API, {
          method: "filemetas",
          access_token: auth.accessToken,
          fsids: JSON.stringify([fsID]),
          dlink: "1",
        })
        const body = await json(
          await request(url, { signal, headers: { "User-Agent": "pan.baidu.com" } }),
          "download",
          "file-metadata",
        )
        const item = Array.isArray(body.list) ? record(body.list[0], "download", "file-metadata") : undefined
        if (!item || typeof item.dlink !== "string") throw invalidResponse("download", "file-metadata", body)
        const link = endpoint(item.dlink, { access_token: auth.accessToken })
        const response = await request(link, { signal, redirect: "follow", headers: { "User-Agent": "pan.baidu.com" } })
        if (!response.ok) throw responseFailure("download", response)
        return new Uint8Array(await response.arrayBuffer())
      },
      signal,
    )
    const after = await stat(object, signal)
    if (!after || after.version !== before.version) throw error("download", "conflict", false)
    return { ...before, bytes }
  }

  const ensureDirectory = (directory: string, signal?: AbortSignal) => {
    const active = directories.get(directory)
    if (active) return active
    const pending = call(
      "upload",
      async (auth) => {
        if (await directoryExists(auth, directory, request, signal)) return
        const created = await form(
          endpoint(FILE_API, { method: "create", access_token: auth.accessToken }),
          { path: directory, isdir: "1", rtype: "0" },
          request,
          "upload",
          signal,
          "directory-create",
        ).catch(async (cause) => {
          // Another client may create the same directory between our list and create calls.
          if (await directoryExists(auth, directory, request, signal)) return
          throw cause
        })
        if (!created) return
        if (created.path !== directory || Number(created.isdir) !== 1)
          throw invalidResponse("upload", "directory-create", created)
      },
      signal,
    ).catch((cause) => {
      directories.delete(directory)
      throw cause
    })
    directories.set(directory, pending)
    return pending
  }

  const ensureParents = async (object: string, signal?: AbortSignal) => {
    const parent = path.posix.dirname(SyncProvider.objectPath(object))
    if (parent === ".") return
    await parent
      .split("/")
      .reduce(
        (ready, _part, index, parts) =>
          ready.then(() => ensureDirectory(`${root}/${parts.slice(0, index + 1).join("/")}`, signal)),
        Promise.resolve(),
      )
  }

  const uploadAtomic = async (
    object: string,
    bytes: Uint8Array,
    precondition: SyncProvider.Precondition,
    signal?: AbortSignal,
  ) => {
    const current = await stat(object, signal)
    checkPrecondition(current, precondition, "upload")
    await ensureParents(object, signal)
    const remote = remotePath(root, object)
    const blocks = split(bytes).map((part) => ({ part, md5: createHash("md5").update(part).digest("hex") }))
    let expectedUploadID: string | undefined
    try {
      return await call(
        "upload",
        async (auth) => {
          const prepared = await form(
            endpoint(FILE_API, { method: "precreate", access_token: auth.accessToken }),
            {
              path: remote,
              size: String(bytes.byteLength),
              isdir: "0",
              autoinit: "1",
              rtype: "3",
              block_list: JSON.stringify(blocks.map((block) => block.md5)),
            },
            request,
            "upload",
            signal,
            "precreate",
          )
          expectedUploadID = string(prepared.uploadid, "upload", "precreate", prepared)
          const requiredParts = uploadParts(prepared.block_list, blocks.length, prepared)
          await Promise.all(
            requiredParts.map(async (index) => {
              const block = blocks[index]!
              const body = new FormData()
              // Keep the explicit filename used by the proven prototype. Some
              // Baidu upload edges reject an unnamed multipart file with HTML.
              body.append("file", new Blob([Uint8Array.from(block.part)]), "blob")
              const uploaded = await json(
                await request(
                  endpoint(UPLOAD_API, {
                    method: "upload",
                    type: "tmpfile",
                    path: remote,
                    uploadid: expectedUploadID!,
                    partseq: String(index),
                    access_token: auth.accessToken,
                  }),
                  { method: "POST", body, signal },
                ),
                "upload",
                "part-upload",
              )
              if (string(uploaded.md5, "upload", "part-upload", uploaded).toLowerCase() !== block.md5)
                throw invalidResponse("upload", "part-upload", uploaded)
            }),
          )
          checkPrecondition(await stat(object, signal), precondition, "upload")
          const created = await form(
            endpoint(FILE_API, { method: "create", access_token: auth.accessToken }),
            {
              path: remote,
              size: String(bytes.byteLength),
              isdir: "0",
              rtype: "3",
              uploadid: expectedUploadID,
              block_list: JSON.stringify(blocks.map((block) => block.md5)),
            },
            request,
            "upload",
            signal,
            "create",
          ).catch((cause) => {
            const failure = classify("upload", cause)
            throw new SyncProvider.ProviderError(
              "baidu",
              "upload",
              failure.kind,
              false,
              "unknown",
              failure.retryAfter,
              failure.providerCode,
              failure.requestID,
              failure.providerPhase,
              failure.httpStatus,
            )
          })
          return createdObjectInfo(object, created)
        },
        signal,
      )
    } catch (cause) {
      const failure = classify("upload", cause)
      if (failure.kind === "conflict" || failure.kind === "unauthenticated" || !expectedUploadID) throw failure
      const verified = await verifyUpload(stat, download, object, bytes, signal).catch(() => undefined)
      if (verified) return verified
      throw new SyncProvider.ProviderError(
        "baidu",
        "upload",
        failure.kind,
        failure.retryable,
        "unknown",
        failure.retryAfter,
        failure.providerCode,
        failure.requestID,
        failure.providerPhase,
        failure.httpStatus,
      )
    }
  }

  const deleteBatch: SyncProvider.Adapter["deleteBatch"] = async (objects, signal) => {
    const checked = await Promise.all(objects.map(async (item) => ({ item, current: await stat(item.path, signal) })))
    const removable = checked.filter(
      ({ item, current }) => current && (!item.version || item.version === current.version),
    )
    if (removable.length)
      await call(
        "delete",
        (auth) =>
          form(
            endpoint(FILE_API, { method: "filemanager", opera: "delete", access_token: auth.accessToken }),
            { async: "0", filelist: JSON.stringify(removable.map(({ item }) => remotePath(root, item.path))) },
            request,
            "delete",
            signal,
            "file-delete",
          ),
        signal,
      )
    return checked.map(({ item, current }) => {
      if (!current) return { path: item.path, status: "missing" as const }
      if (item.version && item.version !== current.version)
        return { path: item.path, status: "conflict" as const, version: current.version }
      return { path: item.path, status: "deleted" as const }
    })
  }

  return {
    id: "baidu",
    list: async (prefix, cursor, signal) => {
      const remote = remotePath(root, prefix)
      const start = cursor ? requireCursor(cursor) : 0
      const result = await call("list", (auth) => listPage("list", auth, remote, start, request, signal), signal).catch(
        (cause) => {
          if (cause instanceof SyncProvider.ProviderError && cause.kind === "not-found")
            return { items: [], more: false }
          throw cause
        },
      )
      return {
        objects: result.items.map((item) => ({ ...item.info, path: item.remotePath.slice(root.length + 1) })),
        ...(result.more ? { cursor: String(start + result.items.length) } : {}),
      }
    },
    stat,
    download,
    uploadAtomic,
    deleteBatch,
  }
}

async function token(
  fields: Record<string, string>,
  appKey: string,
  secretKey: string,
  request: Request,
  now: () => number,
  signal?: AbortSignal,
  previousRefreshToken?: string,
) {
  const response = await request(endpoint(TOKEN_API, fields), { method: "POST", signal })
  const body = await response.json().catch(() => undefined)
  const value = record(body, "stat")
  if (!response.ok || typeof value.error === "string") throw responseFailure("stat", response, value)
  const credential = {
    appKey,
    secretKey,
    accessToken: string(value.access_token, "stat"),
    refreshToken:
      typeof value.refresh_token === "string" && value.refresh_token
        ? value.refresh_token
        : string(previousRefreshToken, "stat"),
    expiresAt: now() + number(value.expires_in, "stat") * 1_000,
  }
  validateCredential(credential)
  return credential
}

async function listPage(
  operation: "list" | "stat",
  auth: Credential,
  directory: string,
  start: number,
  request: Request,
  signal?: AbortSignal,
) {
  const body = await json(
    await request(
      endpoint(FILE_API, {
        method: "list",
        access_token: auth.accessToken,
        dir: directory,
        start: String(start),
        limit: "1000",
        order: "name",
      }),
      { signal, headers: { "User-Agent": "pan.baidu.com" } },
    ),
    operation,
    "file-list",
  )
  if (!Array.isArray(body.list)) throw invalidResponse(operation, "file-list", body)
  return {
    items: body.list
      .filter((item) => record(item, operation, "file-list").isdir !== 1)
      .map((item) => listed(record(item, operation, "file-list"), operation)),
    more: body.has_more === 1,
  }
}

async function listDirectory(auth: Credential, directory: string, request: Request, signal?: AbortSignal) {
  const output = []
  for (let start = 0; ; ) {
    const page = await listPage("stat", auth, directory, start, request, signal)
    output.push(...page.items)
    if (!page.more) return output
    start += page.items.length
    if (!page.items.length) throw invalidResponse("stat", "file-list")
  }
}

async function directoryExists(auth: Credential, directory: string, request: Request, signal?: AbortSignal) {
  const parent = path.posix.dirname(directory)
  for (let start = 0; ; ) {
    const body = await json(
      await request(
        endpoint(FILE_API, {
          method: "list",
          access_token: auth.accessToken,
          dir: parent,
          folder: "1",
          start: String(start),
          limit: "1000",
          order: "name",
        }),
        { signal, headers: { "User-Agent": "pan.baidu.com" } },
      ),
      "upload",
      "directory-list",
    )
    if (!Array.isArray(body.list)) throw invalidResponse("upload", "directory-list", body)
    if (body.list.some((item) => record(item, "upload", "directory-list").path === directory)) return true
    if (body.has_more !== 1) return false
    if (!body.list.length) throw invalidResponse("upload", "directory-list", body)
    start += body.list.length
  }
}

function listed(value: Record<string, unknown>, operation: "list" | "stat") {
  const remotePath = string(value.path, operation, "file-list", value)
  return { remotePath, info: listedObjectInfo(remotePath, value, operation) }
}

function listedObjectInfo(
  object: string,
  value: Record<string, unknown>,
  operation: "list" | "stat",
): SyncProvider.ObjectInfo {
  // Baidu's list endpoint names this server_mtime; the create endpoint below returns mtime instead.
  const fsID = number(value.fs_id, operation, "file-list", value)
  const size = number(value.size, operation, "file-list", value)
  const modifiedAt = number(value.server_mtime, operation, "file-list", value) * 1_000
  return { path: object, version: `${fsID}:${modifiedAt}:${size}`, size, modifiedAt }
}

function createdObjectInfo(object: string, value: Record<string, unknown>): SyncProvider.ObjectInfo {
  const fsID = number(value.fs_id, "upload", "create", value)
  const size = number(value.size, "upload", "create", value)
  const modifiedAt = number(value.mtime, "upload", "create", value) * 1_000
  return { path: object, version: `${fsID}:${modifiedAt}:${size}`, size, modifiedAt }
}

function uploadParts(value: unknown, count: number, body: Record<string, unknown>) {
  if (!Array.isArray(value)) throw invalidResponse("upload", "precreate", body)
  const parts = value.length === 0 ? [0] : value
  if (parts.some((part) => typeof part !== "number" || !Number.isSafeInteger(part) || part < 0 || part >= count))
    throw invalidResponse("upload", "precreate", body)
  return [...new Set(parts)]
}

async function verifyUpload(
  stat: SyncProvider.Adapter["stat"],
  download: SyncProvider.Adapter["download"],
  object: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
) {
  const info = await stat(object, signal)
  if (!info || info.size !== bytes.byteLength) return
  const remote = await download(object, info.version, signal)
  if (!Buffer.from(remote.bytes).equals(Buffer.from(bytes))) return
  return info
}

function checkPrecondition(
  current: SyncProvider.ObjectInfo | undefined,
  precondition: SyncProvider.Precondition,
  operation: "upload",
) {
  if (precondition.type === "any") return
  if (precondition.type === "absent" && !current) return
  if (precondition.type === "version" && current?.version === precondition.version) return
  throw error(operation, "conflict", false)
}

async function form(
  url: URL,
  fields: Record<string, string>,
  request: Request,
  operation: SyncProvider.ProviderError["operation"],
  signal?: AbortSignal,
  providerPhase?: string,
) {
  return json(
    await request(url, {
      method: "POST",
      signal,
      body: new URLSearchParams(fields),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    }),
    operation,
    providerPhase,
  )
}

async function json(response: Response, operation: SyncProvider.ProviderError["operation"], providerPhase?: string) {
  const value = await response.json().catch(() => undefined)
  if (!response.ok)
    throw responseFailure(
      operation,
      response,
      value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined,
      providerPhase,
    )
  const body = record(value, operation, providerPhase)
  if (Number(body.errno ?? 0) !== 0) throw responseFailure(operation, response, body, providerPhase)
  return body
}

function responseFailure(
  operation: SyncProvider.ProviderError["operation"],
  response: Response,
  body?: Record<string, unknown>,
  providerPhase?: string,
) {
  const code = Number(body?.errno ?? body?.error_code)
  const providerCode = Number.isFinite(code) ? code : undefined
  const requestID =
    safeRequestID(body?.request_id) ??
    ["x-bs-request-id", "x-request-id", "x-bce-request-id"]
      .map((name) => safeRequestID(response.headers.get(name)))
      .find((value) => value !== undefined)
  const retryAfter = retryDelay(response.headers.get("retry-after"))
  if (response.status === 401 || code === -6 || code === 111)
    return error(
      operation,
      "unauthenticated",
      false,
      undefined,
      providerCode,
      requestID,
      providerPhase,
      response.status,
    )
  if (response.status === 403 || code === -7)
    return error(operation, "permission", false, undefined, providerCode, requestID, providerPhase, response.status)
  if (response.status === 404 || code === -9 || code === 31066)
    return error(operation, "not-found", false, undefined, providerCode, requestID, providerPhase, response.status)
  if (response.status === 409)
    return error(operation, "conflict", false, undefined, providerCode, requestID, providerPhase, response.status)
  if (response.status === 429 || code === 31034 || code === 31045)
    return error(operation, "rate-limit", true, retryAfter, providerCode, requestID, providerPhase, response.status)
  return error(
    operation,
    response.status >= 500 ? "network" : "provider",
    response.status >= 500,
    retryAfter,
    providerCode,
    requestID,
    providerPhase,
    response.status,
  )
}

function classify(operation: SyncProvider.ProviderError["operation"], cause: unknown) {
  if (cause instanceof SyncProvider.ProviderError) return cause
  if (cause instanceof DOMException && cause.name === "TimeoutError") return error(operation, "network", true)
  if (cause instanceof DOMException && cause.name === "AbortError") return error(operation, "cancelled", false)
  return error(operation, "network", true)
}

export function boundedRequest(request: Request, timeoutMs = REQUEST_TIMEOUT_MS): Request {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Invalid Baidu request timeout")
  return (input, init) => {
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return request(input, { ...init, signal })
  }
}

function error(
  operation: SyncProvider.ProviderError["operation"],
  kind: SyncProvider.ErrorKind,
  retryable: boolean,
  retryAfter?: number,
  providerCode?: number,
  requestID?: string,
  providerPhase?: string,
  httpStatus?: number,
) {
  return new SyncProvider.ProviderError(
    "baidu",
    operation,
    kind,
    retryable,
    "failed",
    retryAfter,
    providerCode,
    requestID,
    providerPhase,
    httpStatus,
  )
}

function safeRequestID(value: unknown) {
  const result = typeof value === "string" || typeof value === "number" ? String(value) : undefined
  return result && /^[A-Za-z0-9_-]{1,128}$/.test(result) ? result : undefined
}

function endpoint(base: string, fields: Record<string, string>) {
  const url = new URL(base)
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value)
  return url
}

function remotePath(root: string, object: string) {
  return `${root}/${SyncProvider.objectPath(object)}`
}

function normalizeRoot(root: string) {
  if (!root.startsWith("/apps/") || root.endsWith("/") || /[\0\r\n]/.test(root))
    throw new Error("Invalid Baidu sync root")
  return root
}

function split(bytes: Uint8Array) {
  if (!bytes.byteLength) return [bytes]
  return Array.from({ length: Math.ceil(bytes.byteLength / PART_SIZE) }, (_, index) =>
    bytes.slice(index * PART_SIZE, (index + 1) * PART_SIZE),
  )
}

function record(
  value: unknown,
  operation: SyncProvider.ProviderError["operation"],
  providerPhase?: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(operation, providerPhase)
  return value as Record<string, unknown>
}

function string(
  value: unknown,
  operation: SyncProvider.ProviderError["operation"],
  providerPhase?: string,
  body?: Record<string, unknown>,
) {
  if (typeof value !== "string" || !value) throw invalidResponse(operation, providerPhase, body)
  return value
}

function number(
  value: unknown,
  operation: SyncProvider.ProviderError["operation"],
  providerPhase?: string,
  body?: Record<string, unknown>,
) {
  const parsed = typeof value === "string" ? Number(value) : value
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0)
    throw invalidResponse(operation, providerPhase, body)
  return parsed
}

function invalidResponse(
  operation: SyncProvider.ProviderError["operation"],
  providerPhase?: string,
  body?: Record<string, unknown>,
) {
  return error(
    operation,
    "invalid-response",
    false,
    undefined,
    undefined,
    safeRequestID(body?.request_id),
    providerPhase,
  )
}

function requireCursor(value: string) {
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw error("list", "invalid-response", false)
  return parsed
}

function retryDelay(value: string | null) {
  if (!value) return
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined
}

function parseCredential(value: string) {
  const parsed = JSON.parse(value) as Credential
  validateCredential(parsed)
  return parsed
}

function validateCredential(value: Credential) {
  if (
    !value ||
    !value.appKey ||
    !value.secretKey ||
    !value.accessToken ||
    !value.refreshToken ||
    !Number.isFinite(value.expiresAt)
  )
    throw new SyncSecureStore.SecureStoreOperationError("Invalid Baidu credential")
}

function delay(milliseconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true },
    )
  })
}
