export * as SessionLocationRebinding from "./session-location-rebinding"

import { Schema } from "effect"
import { Location } from "./location"
import { SessionID } from "./session-id"
import { Target } from "./target"

const batch = Schema.Array(SessionID)

export const Resolution = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("resolved"),
    location: Location.Ref,
    target: Schema.optional(Target.Definition),
  }),
  Schema.Struct({
    status: Schema.Literal("missing_local_target"),
    location: Location.Ref,
    missingTargetID: Location.TargetID,
    lastKnownTargetName: Schema.optional(Schema.String),
    referencedSessionIDs: batch,
  }),
  Schema.Struct({
    status: Schema.Literal("unbound_portable_target"),
    portableTargetLabel: Schema.String,
    directory: Schema.String,
    referencedSessionIDs: batch,
  }),
  Schema.Struct({
    status: Schema.Literal("target_unavailable"),
    location: Location.Ref,
    target: Target.Definition,
    stage: Target.ConnectionStage,
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("resolution_failed"),
    message: Schema.String,
  }),
]).annotate({ identifier: "SessionLocationRebinding.Resolution" })

export const PortableBindingSnapshot = Schema.Struct({
  revision: Schema.String,
  bindings: Schema.Record(Schema.String, Location.TargetID),
}).annotate({ identifier: "SessionLocationRebinding.PortableBindingSnapshot" })

export const RestoreMissingInput = Schema.Struct({
  target: Target.Input,
  expectedSessionIDs: batch,
  expectedRegistryRevision: Schema.String,
}).annotate({ identifier: "SessionLocationRebinding.RestoreMissingInput" })

export const BindPortableInput = Schema.Struct({
  portableTargetLabel: Schema.String,
  targetID: Location.TargetID,
  expectedSessionIDs: batch,
  expectedBindingRevision: Schema.String,
}).annotate({ identifier: "SessionLocationRebinding.BindPortableInput" })

export const RecoveryResult = Schema.Struct({
  resolvedSessionIDs: batch,
  failedSessionIDs: batch,
}).annotate({ identifier: "SessionLocationRebinding.RecoveryResult" })

export const RestoreResult = Schema.Struct({
  ...Target.MutationResult.fields,
  ...RecoveryResult.fields,
}).annotate({ identifier: "SessionLocationRebinding.RestoreResult" })

export const PortableBindingRecoveryResult = Schema.Struct({
  ...PortableBindingSnapshot.fields,
  ...RecoveryResult.fields,
}).annotate({ identifier: "SessionLocationRebinding.PortableBindingRecoveryResult" })

export const RebindInput = Schema.Struct({
  expectedRevision: Schema.Number,
  destination: Location.Ref,
}).annotate({ identifier: "SessionLocationRebinding.RebindInput" })

export const RebindResult = Schema.Struct({
  status: Schema.Literals(["unchanged", "rebound"]),
  revision: Schema.Number,
  warnings: Schema.Array(Schema.String),
}).annotate({ identifier: "SessionLocationRebinding.RebindResult" })
