import { createMemo, createSignal } from "solid-js"
import { createSimpleContext } from "./helper"

export type RemoteStatusArea = "Sync" | "Target"

export type RemoteStatusItem = {
  readonly id: string
  readonly area: RemoteStatusArea
  readonly operation: string
  readonly phase?: string
  readonly state: "running" | "failed"
  readonly detail?: string
  readonly updatedAt: number
}

type FailureFields = {
  stage?: string
  operation?: string
  kind?: string
  retryable?: boolean
  message?: string
}

export const { use: useRemoteStatus, provider: RemoteStatusProvider } = createSimpleContext({
  name: "RemoteStatus",
  init: () => {
    const [items, setItems] = createSignal<readonly RemoteStatusItem[]>([])

    const put = (item: RemoteStatusItem) =>
      setItems((current) => [...current.filter((candidate) => candidate.id !== item.id), item])
    const clear = (id: string) => setItems((current) => current.filter((item) => item.id !== id))
    const current = createMemo(() => items().at(-1))

    return {
      current,
      begin(area: RemoteStatusArea, operation: string, phase?: string) {
        const id = crypto.randomUUID()
        setItems((current) => [
          ...current.filter((item) => item.state !== "failed" || item.area !== area),
          { id, area, operation, phase, state: "running", updatedAt: Date.now() },
        ])
        return id
      },
      update(id: string, input: { operation?: string; phase?: string; detail?: string }) {
        const found = items().find((item) => item.id === id)
        if (!found) return
        put({ ...found, ...input, updatedAt: Date.now() })
      },
      complete: clear,
      fail(id: string, detail: string, phase?: string) {
        const found = items().find((item) => item.id === id)
        if (!found) return
        put({ ...found, state: "failed", phase: phase ?? found.phase, detail, updatedAt: Date.now() })
      },
      set(id: string, input: Omit<RemoteStatusItem, "id" | "updatedAt">) {
        put({ id, ...input, updatedAt: Date.now() })
      },
      clear,
    }
  },
})

export function remoteFailureDetail(value: unknown) {
  const fields = failureFields(value, 0)
  const detail = [
    fields.stage,
    fields.operation,
    fields.kind,
    fields.retryable === undefined ? undefined : fields.retryable ? "retryable" : "not retryable",
    fields.message,
  ]
    .filter((item, index, values): item is string => Boolean(item) && values.indexOf(item) === index)
    .join(" · ")
  return redact(detail || "remote operation failed")
}

function failureFields(value: unknown, depth: number): FailureFields {
  if (depth > 6) return {}
  if (value instanceof Error) {
    const nested = failureFields(value.cause, depth + 1)
    return { ...nested, message: nested.message ?? value.message }
  }
  if (!value || typeof value !== "object") return typeof value === "string" ? { message: value } : {}
  const record = value as Record<string, unknown>
  const own = {
    stage: typeof record.stage === "string" ? record.stage : undefined,
    operation: typeof record.operation === "string" ? record.operation : undefined,
    kind: typeof record.kind === "string" ? record.kind : undefined,
    retryable: typeof record.retryable === "boolean" ? record.retryable : undefined,
    message: typeof record.message === "string" ? record.message : undefined,
  }
  return [record.diagnostic, record.data, record.error, record.body, record.cause].reduce<FailureFields>(
    (result, item) => {
      const nested = failureFields(item, depth + 1)
      return {
        stage: result.stage ?? nested.stage,
        operation: result.operation ?? nested.operation,
        kind: result.kind ?? nested.kind,
        retryable: result.retryable ?? nested.retryable,
        message: result.message ?? nested.message,
      }
    },
    own,
  )
}

function redact(value: string) {
  return value
    .replace(/(access[_-]?token|refresh[_-]?token|authorization|secret|password|code)=([^\s&]+)/gi, "$1=[redacted]")
    .replace(/bearer\s+[^\s]+/gi, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/gi, "[remote URL]")
}
