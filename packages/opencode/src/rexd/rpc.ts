import { RexdError, cancelled } from "./error"
import { REXD_BASELINE_VERSION } from "./manifest"
import type { Transport } from "./ssh"

const REQUIRED_CAPABILITIES = ["exec", "fs", "events", "pty"] as const
// rexd/1 session.open exposes these two enforceable request ceilings. The
// remaining daemon limits are version-pinned server behavior, not negotiated
// fields in the baseline wire protocol.
const REQUIRED_LIMITS = ["default_timeout_ms", "max_output_bytes"] as const

export type RexdHandshake = {
  sessionID: string
  protocol: "rexd/1"
  serverVersion: string
  capabilities: readonly string[]
  limits: Readonly<Record<string, number>>
  workspaceRoots: readonly string[]
}

type Pending = {
  method: string
  resolve(value: unknown): void
  reject(error: RexdError): void
  timer: ReturnType<typeof setTimeout>
  removeAbort?: () => void
}

export class RexdRpcClient {
  readonly #pending = new Map<number, Pending>()
  readonly #notifications = new Set<(method: string, params: unknown) => void>()
  readonly #closeListeners = new Set<(error: RexdError) => void>()
  readonly #removeData: () => void
  readonly #removeClose: () => void
  #buffer = ""
  #requestID = 0
  #closed = false

  constructor(
    readonly transport: Transport,
    readonly maxLineBytes = 1024 * 1024,
  ) {
    this.#removeData = transport.onData((chunk) => this.#data(chunk))
    this.#removeClose = transport.onClose((error) => this.close(error))
  }

  async request(
    method: string,
    params: Readonly<Record<string, unknown>>,
    options: { timeoutMs?: number; signal?: AbortSignal; sideEffect?: boolean } = {},
  ) {
    if (this.#closed)
      throw new RexdError("transport", "Rexd connection is closed", true, options.sideEffect ? "unknown" : "failed")
    if (options.signal?.aborted) throw cancelled(options.signal)
    const id = ++this.#requestID
    const result = new Promise<unknown>((resolve, reject) => {
      const abort = () => this.#settle(id, cancelled(options.signal!, options.sideEffect ? "unknown" : "failed"))
      const timer = setTimeout(
        () =>
          this.#settle(
            id,
            new RexdError(
              "transport",
              `Rexd request timed out: ${method}`,
              true,
              options.sideEffect ? "unknown" : "failed",
            ),
          ),
        options.timeoutMs ?? 30_000,
      )
      this.#pending.set(id, {
        method,
        resolve,
        reject,
        timer,
        removeAbort: options.signal ? () => options.signal?.removeEventListener("abort", abort) : undefined,
      })
      options.signal?.addEventListener("abort", abort, { once: true })
    })
    await this.transport.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`).catch(() => {
      this.#settle(
        id,
        new RexdError(
          "transport",
          `Could not send Rexd request: ${method}`,
          true,
          options.sideEffect ? "unknown" : "failed",
        ),
      )
    })
    return result
  }

  async open(input: { clientVersion: string; workspaceRoots: readonly string[]; signal?: AbortSignal }) {
    const value = await this.request(
      "session.open",
      {
        client_name: "opencode-transit",
        client_version: input.clientVersion,
        workspace_roots: input.workspaceRoots,
        requested_capabilities: REQUIRED_CAPABILITIES,
      },
      { timeoutMs: 20_000, signal: input.signal },
    )
    return validateHandshake(value)
  }

  onNotification(listener: (method: string, params: unknown) => void) {
    this.#notifications.add(listener)
    return () => this.#notifications.delete(listener)
  }

  onClose(listener: (error: RexdError) => void) {
    this.#closeListeners.add(listener)
    return () => this.#closeListeners.delete(listener)
  }

  async close(reason = new RexdError("transport", "Rexd connection closed", true)) {
    if (this.#closed) return
    this.#closed = true
    this.#removeData()
    this.#removeClose()
    ;[...this.#pending.keys()].forEach((id) => this.#settle(id, reason))
    this.#closeListeners.forEach((listener) => listener(reason))
    this.#closeListeners.clear()
    this.#notifications.clear()
    await this.transport.close()
  }

  #data(chunk: string) {
    this.#buffer += chunk
    const lines = this.#buffer.split("\n")
    this.#buffer = lines.pop() ?? ""
    if (
      Buffer.byteLength(this.#buffer, "utf8") > this.maxLineBytes ||
      lines.some((line) => Buffer.byteLength(line, "utf8") > this.maxLineBytes)
    ) {
      void this.close(new RexdError("transport", "Rexd frame exceeded the safety limit", false, "unknown"))
      return
    }
    lines.filter(Boolean).forEach((line) => this.#line(line))
  }

  #line(line: string) {
    const value = parseRecord(line)
    if (!value) return void this.close(new RexdError("transport", "Rexd sent invalid JSON-RPC", false, "unknown"))
    if (!("id" in value)) {
      if (typeof value.method !== "string")
        return void this.close(new RexdError("transport", "Rexd sent an invalid event", false, "unknown"))
      this.#notifications.forEach((listener) => listener(value.method as string, value.params))
      return
    }
    const id = typeof value.id === "number" ? value.id : Number(value.id)
    const pending = this.#pending.get(id)
    if (!pending) return
    if (isRecord(value.error)) {
      const code = typeof value.error.code === "number" ? value.error.code : undefined
      const detail = typeof value.error.message === "string" ? `: ${value.error.message}` : ""
      this.#settle(
        id,
        new RexdError("transport", `Rexd rejected ${pending.method}${code ? ` (${code})` : ""}${detail}`, false),
      )
      return
    }
    this.#settle(id, undefined, value.result)
  }

  #settle(id: number, error?: RexdError, value?: unknown) {
    const pending = this.#pending.get(id)
    if (!pending) return
    this.#pending.delete(id)
    clearTimeout(pending.timer)
    pending.removeAbort?.()
    if (error) return pending.reject(error)
    pending.resolve(value)
  }
}

export function validateHandshake(value: unknown): RexdHandshake {
  if (!isRecord(value)) throw new RexdError("handshake", "Rexd returned an invalid handshake", false)
  if (value.protocol !== "rexd/1")
    throw new RexdError("handshake", "Rexd protocol is not compatible with rexd/1", false)
  if (typeof value.session_id !== "string" || !value.session_id)
    throw new RexdError("handshake", "Rexd omitted session identity", false)
  if (typeof value.server_version !== "string" || !value.server_version)
    throw new RexdError("handshake", "Rexd omitted server version", false)
  if (value.server_version.replace(/^v/, "") !== REXD_BASELINE_VERSION.replace(/^v/, "")) {
    throw new RexdError("handshake", `Rexd server version is incompatible with ${REXD_BASELINE_VERSION}`, false)
  }
  if (!isStringArray(value.capabilities)) throw new RexdError("handshake", "Rexd returned invalid capabilities", false)
  const capabilities = value.capabilities
  const missing = REQUIRED_CAPABILITIES.filter((capability) => !capabilities.includes(capability))
  if (missing.length)
    throw new RexdError("capability", `Rexd is missing required capabilities: ${missing.join(", ")}`, false)
  if (!isNumberRecord(value.limits)) throw new RexdError("handshake", "Rexd returned invalid limits", false)
  const limits = value.limits
  const missingLimits = REQUIRED_LIMITS.filter((limit) => !Number.isFinite(limits[limit]) || limits[limit]! <= 0)
  if (missingLimits.length)
    throw new RexdError("capability", `Rexd is missing required limits: ${missingLimits.join(", ")}`, false)
  if (
    !isStringArray(value.workspace_roots) ||
    value.workspace_roots.length === 0 ||
    value.workspace_roots.some((root) => !root.startsWith("/"))
  ) {
    throw new RexdError("capability", "Rexd returned no valid workspace roots", false)
  }
  return {
    sessionID: value.session_id,
    protocol: value.protocol,
    serverVersion: value.server_version,
    capabilities,
    limits,
    workspaceRoots: value.workspace_roots,
  }
}

function parseRecord(value: string) {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) && parsed.jsonrpc === "2.0" ? parsed : undefined
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "number")
}
