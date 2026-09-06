import { Location } from "@opencode-ai/schema/location"
import { Target } from "@opencode-ai/schema/target"
import { SessionLocationRebinding } from "@opencode-ai/schema/session-location-rebinding"
import { SessionID } from "@opencode-ai/schema/session-id"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { ConflictError, ForbiddenError, InvalidRequestError, TargetNotFoundError, UnknownError } from "../errors"

const errors = [ConflictError, ForbiddenError, InvalidRequestError, TargetNotFoundError, UnknownError] as const
const mutation = Schema.Struct({ input: Target.Input, expectedRevision: Schema.String })

export const TargetGroup = HttpApiGroup.make("server.target")
  .add(
    HttpApiEndpoint.get("target.list", "/api/target", { success: Target.Snapshot, error: UnknownError }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.target.list", summary: "List device-local execution targets" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("target.resolveSession", "/api/session/:sessionID/target-resolution", {
      params: { sessionID: SessionID },
      success: SessionLocationRebinding.Resolution,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.sessionLocation.resolve", summary: "Resolve a Session execution target" }),
    ),
  )
  .add(
    HttpApiEndpoint.get("target.bindingList", "/api/target-binding", {
      success: SessionLocationRebinding.PortableBindingSnapshot,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.targetBinding.list", summary: "List device-local portable bindings" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("target.bindPortable", "/api/target-binding/:portableTargetLabel", {
      params: { portableTargetLabel: Schema.String },
      payload: Schema.Struct({
        targetID: Location.TargetID,
        expectedRevision: Schema.String,
        expectedSessionIDs: Schema.Array(SessionID),
      }),
      success: SessionLocationRebinding.PortableBindingSnapshot,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.targetBinding.bind", summary: "Explicitly bind a portable target label" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("target.rebindSession", "/api/session/:sessionID/location/rebind", {
      params: { sessionID: SessionID },
      payload: SessionLocationRebinding.RebindInput,
      success: SessionLocationRebinding.RebindResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.sessionLocation.rebind", summary: "Force rebind one idle Session" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("target.wizard.inspect", "/api/target/wizard/inspect", {
      payload: Schema.Struct({ input: Target.Input }),
      success: Target.WizardInspection,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.target.wizard.inspect", summary: "Inspect a target draft" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("target.wizard.complete", "/api/target/wizard/complete", {
      payload: Schema.Struct({
        input: Target.Input,
        value: Schema.String,
        cursor: Schema.Number,
        cwd: Schema.String,
      }),
      success: Target.PathCompletion,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.target.wizard.complete", summary: "Complete a remote directory" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("target.create", "/api/target", {
      payload: mutation,
      success: Target.MutationResult,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.target.create", summary: "Create an execution target" })),
  )
  .add(
    HttpApiEndpoint.put("target.update", "/api/target/:targetID", {
      params: { targetID: Location.TargetID },
      payload: mutation,
      success: Target.MutationResult,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.target.update", summary: "Update an execution target" })),
  )
  .add(
    HttpApiEndpoint.delete("target.remove", "/api/target/:targetID", {
      params: { targetID: Location.TargetID },
      payload: Schema.Struct({ expectedRevision: Schema.String }),
      success: Target.Snapshot,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.target.remove", summary: "Remove an execution target" })),
  )
  .add(
    HttpApiEndpoint.post("target.restore", "/api/target/:targetID/restore", {
      params: { targetID: Location.TargetID },
      payload: Schema.Struct({
        input: Target.Input,
        referencedSessionIDs: Schema.Array(Schema.String),
        expectedRevision: Schema.String,
      }),
      success: Target.MutationResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.target.restore",
        summary: "Restore an RFC-0009 authorized missing target",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("target.test", "/api/target/:targetID/test", {
      params: { targetID: Location.TargetID },
      success: Target.ProbeResult,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.target.test", summary: "Test a target connection" })),
  )
  .add(
    HttpApiEndpoint.post("target.prepare", "/api/target/:targetID/prepare", {
      params: { targetID: Location.TargetID },
      success: Target.ProbeResult,
      error: errors,
    }).annotateMerge(OpenApi.annotations({ identifier: "v2.target.prepare", summary: "Prepare a target" })),
  )
  .add(
    HttpApiEndpoint.get("target.legacy.preview", "/api/target/legacy/import", {
      success: Target.ImportPreview,
      error: UnknownError,
    }).annotateMerge(
      OpenApi.annotations({
        identifier: "v2.target.legacy.preview",
        summary: "Preview an explicit legacy target import",
      }),
    ),
  )
  .add(
    HttpApiEndpoint.post("target.legacy.import", "/api/target/legacy/import", {
      payload: Schema.Struct({ sourceRevision: Schema.String, expectedRevision: Schema.String }),
      success: Target.ImportResult,
      error: errors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.target.legacy.import", summary: "Confirm a legacy target import" }),
    ),
  )
  .annotateMerge(OpenApi.annotations({ title: "targets", description: "Device-local execution target registry." }))
