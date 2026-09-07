export * as SyncTransferEvent from "./sync-transfer-event"

import { Schema } from "effect"
import { Event } from "./event"
import { NonNegativeInt, optional } from "./schema"

export const Progress = Schema.Union([
  Schema.Struct({ state: Schema.Literal("idle") }),
  Schema.Struct({
    state: Schema.Literal("active"),
    direction: Schema.Literals(["upload", "download"]),
    phase: Schema.Literals(["sessions", "attachments"]),
    items: optional(NonNegativeInt),
    bytes: optional(NonNegativeInt),
  }),
])
export type Progress = typeof Progress.Type

export const Updated = Event.define({
  type: "sync.transfer.updated",
  schema: { progress: Progress },
})

export const Definitions = Event.inventory(Updated)
