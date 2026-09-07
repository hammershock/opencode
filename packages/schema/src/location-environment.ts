export * as LocationEnvironment from "./location-environment"

import { Schema } from "effect"

export const Origin = Schema.Literals(["base", "user", "project", "explicit"])

export const Variable = Schema.Struct({
  name: Schema.String,
  origin: Origin,
  source: Schema.optional(Schema.String),
  overrides: Schema.Array(Origin),
})

export const Source = Schema.Struct({
  path: Schema.String,
  origin: Schema.Literals(["user", "project"]),
  present: Schema.Boolean,
})

export const Snapshot = Schema.Struct({
  enabled: Schema.Boolean,
  generation: Schema.Number,
  variables: Schema.Array(Variable),
  sources: Schema.Array(Source),
})

export const Values = Schema.Struct({
  generation: Schema.Number,
  values: Schema.Record(Schema.String, Schema.String),
})

export const InitResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("completed"),
    template: Schema.Literals(["created", "existing"]),
    generation: Schema.Number,
  }),
  Schema.Struct({
    status: Schema.Literals(["cancelled", "failed"]),
    template: Schema.Literals(["created", "existing"]),
  }),
])
