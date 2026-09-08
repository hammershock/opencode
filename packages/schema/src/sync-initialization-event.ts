export * as SyncInitializationEvent from "./sync-initialization-event"

import { Schema } from "effect"
import { Event } from "./event"

export const Required = Event.define({
  type: "sync.initialization.required",
  schema: { trigger: Schema.Literal("automatic") },
})

export const Definitions = Event.inventory(Required)
