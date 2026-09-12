export * as ModelContext from "./model-context"

import { Schema } from "effect"
import { NonNegativeInt, optional } from "./schema"

/** Stable namespaced identity for one independently managed model-context source. */
export const Key = Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._/-]*$/)).pipe(
  Schema.brand("ModelContext.Key"),
)
export type Key = typeof Key.Type

/** Durable comparison state retained for one admitted source. */
export const SourceSnapshot = Schema.Struct({
  value: Schema.Json,
  /** Model-visible rendering of this exact value, retained so compaction never reloads its source. */
  baseline: optional(Schema.String),
  removed: optional(Schema.NonEmptyString),
  refresh: optional(Schema.Literals(["generation", "activation"])),
}).annotate({ identifier: "ModelContext.SourceSnapshot" })
export type SourceSnapshot = typeof SourceSnapshot.Type

/** Generic source snapshot used by Core context producers. */
export const SourceState = Schema.Record(Key, SourceSnapshot).annotate({ identifier: "ModelContext.SourceState" })
export type SourceState = Readonly<Record<string, SourceSnapshot>>

const EnvironmentFields = {
  targetKind: Schema.Literals(["local", "rexd"]),
  targetName: Schema.NonEmptyString,
  directory: Schema.NonEmptyString,
  projectRoot: Schema.NonEmptyString,
  vcs: optional(Schema.NonEmptyString),
  platform: Schema.NonEmptyString,
}

export const Environment = Schema.Union([
  Schema.Struct({
    harness: Schema.Literal("OpenCode Transit"),
    entrypoint: Schema.Literal("opencode-transit"),
    ...EnvironmentFields,
  }),
  // Context generations are durable and retain the product identity accepted
  // before the Transit rename. Preserve that exact historical snapshot.
  Schema.Struct({
    harness: Schema.Literal("OpenCode REXD"),
    entrypoint: Schema.Literal("opencode-rexd"),
    ...EnvironmentFields,
  }),
]).annotate({ identifier: "ModelContext.Environment" })
export type Environment = typeof Environment.Type

export const ControllerTime = Schema.Struct({
  date: Schema.NonEmptyString,
  timezone: Schema.NonEmptyString,
}).annotate({ identifier: "ModelContext.ControllerTime" })
export type ControllerTime = typeof ControllerTime.Type

export const Instruction = Schema.Struct({
  id: Schema.NonEmptyString,
  origin: Schema.Literals(["global-file", "project-file", "configured-file", "configured-url", "nested-file"]),
  scope: Schema.Literals(["global", "project", "nested"]),
  source: Schema.NonEmptyString,
  declaredBy: optional(Schema.NonEmptyString),
  status: Schema.Literals(["loaded", "ignored"]),
  failureStage: optional(Schema.Literals(["discovery", "read", "fetch"])),
  content: optional(Schema.String),
  digest: optional(Schema.NonEmptyString),
}).annotate({ identifier: "ModelContext.Instruction" })
export type Instruction = typeof Instruction.Type

export const Instructions = Schema.Array(Instruction).annotate({ identifier: "ModelContext.Instructions" })
export type Instructions = typeof Instructions.Type

export const GenerationReason = Schema.Literals(["created", "legacy-backfill", "location-rebound", "init"])
export type GenerationReason = typeof GenerationReason.Type

/** Canonical, durable identity for one accepted Location-aware context generation. */
export const Generation = Schema.Struct({
  version: Schema.Literal(1),
  generation: NonNegativeInt,
  reason: GenerationReason,
  locationRevision: NonNegativeInt,
  environment: Environment,
  instructions: Instructions,
  digest: Schema.NonEmptyString,
  baseline: Schema.String,
  /** Complete source state also retains dynamic context owned outside the Location snapshot. */
  sources: SourceState,
}).annotate({ identifier: "ModelContext.Generation" })
export type Generation = typeof Generation.Type
