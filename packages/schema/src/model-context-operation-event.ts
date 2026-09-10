export * as ModelContextOperationEvent from "./model-context-operation-event"

import { Schema } from "effect"
import { Event } from "./event"
import { optional } from "./schema"

export const Progress = Schema.Struct({
  id: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  state: Schema.Literals(["active", "idle", "failed"]),
  phase: Schema.NonEmptyString,
  source: optional(Schema.NonEmptyString),
  detail: optional(Schema.NonEmptyString),
})
export type Progress = typeof Progress.Type

export const Updated = Event.define({
  type: "model-context.operation.updated",
  schema: { progress: Progress },
})

export const Definitions = Event.inventory(Updated)
