export * as SyncTransfer from "./transfer"

import { SyncTransferEvent } from "@opencode-ai/schema/sync-transfer-event"

export type Direction = "upload" | "download"
export type Phase = "sessions" | "attachments"

export interface Observer {
  readonly start: (direction: Direction, phase: Phase) => Promise<void>
  readonly complete: (direction: Direction, phase: Phase, bytes: number) => Promise<void>
  readonly finish: () => Promise<void>
}

export function make(send: (progress: SyncTransferEvent.Progress) => Promise<void>): Observer {
  let current: { direction: Direction; phase: Phase; items: number; bytes: number } | undefined

  const publish = (progress: SyncTransferEvent.Progress) =>
    send(progress).then(
      () => undefined,
      () => undefined,
    )
  const activate = (direction: Direction, phase: Phase) => {
    if (current?.direction === direction && current.phase === phase) return current
    current = { direction, phase, items: 0, bytes: 0 }
    return current
  }
  const progress = () => {
    if (!current) return Promise.resolve()
    return publish({
      state: "active",
      direction: current.direction,
      phase: current.phase,
      ...(current.items ? { items: current.items } : {}),
      ...(current.bytes ? { bytes: current.bytes } : {}),
    })
  }

  return {
    start(direction, phase) {
      activate(direction, phase)
      return progress()
    },
    complete(direction, phase, bytes) {
      const state = activate(direction, phase)
      state.items++
      state.bytes += bytes
      return progress()
    },
    async finish() {
      if (!current) return
      current = undefined
      await publish({ state: "idle" })
    },
  }
}
