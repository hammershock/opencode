import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import { Flag } from "@opencode-ai/core/flag/flag"
import { createSimpleContext } from "./helper"
import { batch, onCleanup, onMount } from "solid-js"
import { remoteFailureDetail, useRemoteStatus } from "./remote-status"

export type EventSource = {
  subscribe: (handler: (event: GlobalEvent) => void) => Promise<() => void>
}

export const { use: useSDK, provider: SDKProvider } = createSimpleContext({
  name: "SDK",
  init: (props: {
    url: string
    directory?: string
    fetch?: typeof fetch
    headers?: RequestInit["headers"]
    events?: EventSource
  }) => {
    const abort = new AbortController()
    const remoteStatus = useRemoteStatus()
    const sourceFetch = props.fetch ?? fetch
    let sse: AbortController | undefined

    const trackedFetch = (async (input, init) => {
      const operation = remoteRequest(input, init)
      if (!operation) return sourceFetch(input, init)
      const id = remoteStatus.begin(operation.area, operation.operation, operation.phase)
      try {
        const response = await sourceFetch(input, init)
        const body =
          !response.ok || operation.inspectResponse
            ? await response
                .clone()
                .json()
                .catch(() => undefined)
            : undefined
        if (!response.ok) {
          remoteStatus.fail(id, remoteFailureDetail(body ?? `HTTP ${response.status}`), operation.phase)
          return response
        }
        if (
          operation.inspectResponse &&
          body &&
          typeof body === "object" &&
          "status" in body &&
          body.status !== (operation.successStatus ?? "ready")
        ) {
          const value = body as { stage?: string; message?: string; status?: string }
          remoteStatus.fail(
            id,
            remoteFailureDetail({ stage: value.stage, kind: value.status, message: value.message }),
            value.stage ?? operation.phase,
          )
          return response
        }
        remoteStatus.complete(id)
        return response
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") remoteStatus.complete(id)
        else remoteStatus.fail(id, remoteFailureDetail(error), operation.phase)
        throw error
      }
    }) as typeof fetch

    function createSDK() {
      return createOpencodeClient({
        baseUrl: props.url,
        signal: abort.signal,
        directory: props.directory,
        fetch: trackedFetch,
        headers: props.headers,
      })
    }

    let sdk = createSDK()

    const request = (pathname: string, init?: RequestInit) => {
      const url = new URL(pathname, props.url)
      const headers = new Headers(props.headers)
      new Headers(init?.headers).forEach((value, key) => headers.set(key, value))
      return trackedFetch(url, { ...init, headers, signal: init?.signal ?? abort.signal })
    }

    const handlers = new Set<(event: GlobalEvent) => void>()
    const emitter = {
      emit(_type: "event", event: GlobalEvent) {
        for (const handler of handlers) handler(event)
      },
      on(_type: "event", handler: (event: GlobalEvent) => void) {
        handlers.add(handler)
        return () => {
          handlers.delete(handler)
        }
      },
    }

    let queue: GlobalEvent[] = []
    let timer: Timer | undefined
    let last = 0
    const retryDelay = 1000
    const maxRetryDelay = 30000

    const flush = () => {
      if (queue.length === 0) return
      const events = queue
      queue = []
      timer = undefined
      last = Date.now()
      // Batch all event emissions so all store updates result in a single render
      batch(() => {
        for (const event of events) {
          emitter.emit("event", event)
        }
      })
    }

    const handleEvent = (event: GlobalEvent) => {
      if (event.payload.type === "model-context.operation.updated") {
        const progress = event.payload.properties.progress
        const id = `model-context:${progress.id}`
        if (progress.state === "idle") remoteStatus.clear(id)
        else
          remoteStatus.set(id, {
            area: "Target",
            operation: `${progress.target} model context`,
            phase: progress.source ? `${progress.phase} · ${progress.source}` : progress.phase,
            state: progress.state === "active" ? "running" : "failed",
            detail: progress.detail ? remoteFailureDetail(progress.detail) : undefined,
          })
      }
      queue.push(event)
      const elapsed = Date.now() - last

      if (timer) return
      // If we just flushed recently (within 16ms), batch this with future events
      // Otherwise, process immediately to avoid latency
      if (elapsed < 16) {
        timer = setTimeout(flush, 16)
        return
      }
      flush()
    }

    function startSSE() {
      sse?.abort()
      const ctrl = new AbortController()
      sse = ctrl
      ;(async () => {
        let attempt = 0
        while (true) {
          if (abort.signal.aborted || ctrl.signal.aborted) break

          const events = await sdk.global.event({
            signal: ctrl.signal,
            sseMaxRetryAttempts: 0,
          })

          if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
            // Start syncing workspaces, it's important to do this after
            // we've started listening to events
            await sdk.sync.start().catch(() => {})
          }

          for await (const event of events.stream) {
            if (ctrl.signal.aborted) break
            handleEvent(event)
          }

          if (timer) clearTimeout(timer)
          if (queue.length > 0) flush()
          attempt += 1
          if (abort.signal.aborted || ctrl.signal.aborted) break

          // Exponential backoff
          const backoff = Math.min(retryDelay * 2 ** (attempt - 1), maxRetryDelay)
          await new Promise((resolve) => setTimeout(resolve, backoff))
        }
      })().catch(() => {})
    }

    onMount(async () => {
      if (props.events) {
        const unsub = await props.events.subscribe(handleEvent)
        onCleanup(unsub)

        if (Flag.OPENCODE_EXPERIMENTAL_WORKSPACES) {
          // Start syncing workspaces, it's important to do this after
          // we've started listening to events
          await sdk.sync.start().catch(() => {})
        }
      } else {
        startSSE()
      }
    })

    onCleanup(() => {
      abort.abort()
      sse?.abort()
      if (timer) clearTimeout(timer)
      handlers.clear()
    })

    return {
      get client() {
        return sdk
      },
      directory: props.directory,
      event: emitter,
      fetch: trackedFetch,
      request,
      url: props.url,
    }
  },
})

export function remoteRequest(input: RequestInfo | URL, init?: RequestInit) {
  const url = new URL(input instanceof Request ? input.url : String(input))
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase()
  const sync = syncOperation(url.pathname, method)
  if (sync) return { area: "Sync" as const, ...sync }

  if (url.pathname === "/api/target/wizard/inspect")
    return { area: "Target" as const, operation: "open target connection", phase: "SSH and Rexd" }
  if (url.pathname === "/api/target/wizard/complete")
    return { area: "Target" as const, operation: "complete remote path", phase: "filesystem" }
  if (/^\/api\/target\/[^/]+\/(test|refresh)$/.test(url.pathname))
    return { area: "Target" as const, operation: "test connection", phase: "SSH", inspectResponse: true }
  if (/^\/api\/target\/[^/]+\/prepare$/.test(url.pathname))
    return { area: "Target" as const, operation: "prepare target", phase: "daemon and handshake" }
  if (/^\/api\/session\/[^/]+\/target-resolution$/.test(url.pathname))
    return {
      area: "Target" as const,
      operation: "open session target",
      phase: "SSH and Rexd",
      inspectResponse: true,
      successStatus: "resolved",
    }
  if (url.pathname.startsWith("/api/fs/") && remoteLocation(url))
    return {
      area: "Target" as const,
      operation: url.pathname.includes("directory/status")
        ? "validate directory"
        : url.pathname.endsWith("/directory")
          ? "create directory"
          : "inspect remote files",
      phase: "filesystem",
    }
}

function syncOperation(pathname: string, method: string) {
  if (pathname === "/global/sync/oauth/begin") return { operation: "connect account", phase: "authorization" }
  if (pathname === "/global/sync/oauth/complete" || pathname === "/global/sync/oauth/switch-account")
    return { operation: "connect account", phase: "token exchange" }
  if (pathname === "/global/sync/cloud" && method === "GET")
    return { operation: "check cloud status", phase: "manifest" }
  if (pathname === "/global/sync/cloud" && method === "POST")
    return { operation: "initialize cloud sync", phase: "prepare directory" }
  if (pathname === "/global/sync/cloud" && method === "DELETE")
    return { operation: "clear cloud sync data", phase: "invalidate and delete" }
  if (pathname === "/global/sync/spaces" && method === "GET")
    return { operation: "refresh cloud status", phase: "discover spaces" }
  if (pathname === "/global/sync/spaces" && method === "POST")
    return { operation: "create space", phase: "publish catalog" }
  if (pathname === "/global/sync/spaces/join") return { operation: "enter space", phase: "verify catalog" }
  if (pathname === "/global/sync/spaces/activate") return { operation: "switch space", phase: "flush and activate" }
  if (/^\/global\/sync\/spaces\/[^/]+$/.test(pathname) && method === "DELETE")
    return { operation: "delete space", phase: "publish deletion marker" }
  if (pathname === "/global/sync/now") return { operation: "synchronize", phase: "exchange changes" }
  if (pathname === "/global/sync/sessions") return { operation: "refresh sessions", phase: "index remote heads" }
  if (pathname === "/global/sync/hydrate") return { operation: "download session", phase: "hydrate" }
  if (pathname === "/global/sync/devices")
    return { operation: method === "GET" ? "refresh devices" : "update device", phase: "device heads" }
}

function remoteLocation(url: URL) {
  const target = url.searchParams.get("location[target]")
  if (target) return true
  const value = url.searchParams.get("location")
  if (!value) return false
  try {
    const location = JSON.parse(value) as { target?: unknown }
    return typeof location.target === "string" && location.target.length > 0
  } catch {
    return false
  }
}
