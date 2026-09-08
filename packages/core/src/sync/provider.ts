export * as SyncProvider from "./provider"

export type Cursor = string

export type ObjectInfo = {
  readonly path: string
  readonly version: string
  readonly size: number
  readonly modifiedAt?: number
}

export type ListPage = {
  readonly objects: readonly ObjectInfo[]
  readonly cursor?: Cursor
}

export type Download = ObjectInfo & {
  readonly bytes: Uint8Array
}

export type Precondition =
  | { readonly type: "absent" }
  | { readonly type: "version"; readonly version: string }
  | { readonly type: "any" }

export interface Adapter {
  readonly id: string
  readonly list: (prefix: string, cursor?: Cursor, signal?: AbortSignal) => Promise<ListPage>
  readonly stat: (path: string, signal?: AbortSignal) => Promise<ObjectInfo | undefined>
  readonly download: (path: string, version?: string, signal?: AbortSignal) => Promise<Download>
  readonly uploadAtomic: (
    path: string,
    bytes: Uint8Array,
    precondition: Precondition,
    signal?: AbortSignal,
  ) => Promise<ObjectInfo>
  readonly deleteBatch: (
    objects: readonly { readonly path: string; readonly version?: string }[],
    signal?: AbortSignal,
  ) => Promise<readonly DeleteResult[]>
}

export type DeleteResult =
  | { readonly path: string; readonly status: "deleted" | "missing" }
  | { readonly path: string; readonly status: "conflict"; readonly version: string }

export type ErrorKind =
  | "unauthenticated"
  | "permission"
  | "not-found"
  | "conflict"
  | "rate-limit"
  | "network"
  | "provider"
  | "cancelled"
  | "invalid-response"

export class ProviderError extends Error {
  override readonly name = "SyncProvider.Error"

  constructor(
    readonly providerID: string,
    readonly operation: "list" | "stat" | "download" | "upload" | "delete",
    readonly kind: ErrorKind,
    readonly retryable: boolean,
    readonly outcome: "failed" | "unknown" = "failed",
    readonly retryAfter?: number,
    readonly providerCode?: number,
    readonly requestID?: string,
  ) {
    super(`${providerID} ${operation} failed (${kind})`)
  }
}

export function objectPath(value: string) {
  if (
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.split("/").some((part) => !part || part === "." || part === ".." || /[\0\r\n]/.test(part))
  )
    throw new Error("Invalid sync object path")
  return value
}

export async function listAll(adapter: Adapter, prefix: string, signal?: AbortSignal) {
  objectPath(prefix)
  const objects: ObjectInfo[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    signal?.throwIfAborted()
    const page = await adapter.list(prefix, cursor, signal)
    for (const item of page.objects) {
      objectPath(item.path)
      if (!item.path.startsWith(prefix)) throw new ProviderError(adapter.id, "list", "invalid-response", false)
      objects.push(item)
    }
    cursor = page.cursor
    if (cursor && cursors.has(cursor)) throw new ProviderError(adapter.id, "list", "invalid-response", false)
    if (cursor) cursors.add(cursor)
  } while (cursor)
  return objects
}

export async function resolveUnknownUpload(input: {
  readonly adapter: Adapter
  readonly path: string
  readonly expectedVersion?: string
  readonly verify: (object: Download) => Promise<boolean>
  readonly signal?: AbortSignal
}) {
  const info = await input.adapter.stat(objectPath(input.path), input.signal)
  if (!info) return { status: "missing" } as const
  if (input.expectedVersion && info.version !== input.expectedVersion)
    return { status: "conflict", object: info } as const
  const object = await input.adapter.download(input.path, info.version, input.signal)
  return (await input.verify(object))
    ? ({ status: "committed", object: info } as const)
    : ({ status: "conflict", object: info } as const)
}
