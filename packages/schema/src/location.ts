export * as Location from "./location"

import { Effect, Schema } from "effect"
import { AbsolutePath, optional } from "./schema"
import { ProjectID } from "./project-id"
import { WorkspaceID } from "./workspace-id"

export const TargetID = Schema.String.check(
  Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
).pipe(Schema.brand("Location.TargetID"))
export type TargetID = typeof TargetID.Type

export const LocalTarget = Schema.Struct({ type: Schema.Literal("local") }).annotate({
  identifier: "Location.LocalTarget",
})
export type LocalTarget = typeof LocalTarget.Type

export const RexdTarget = Schema.Struct({
  type: Schema.Literal("rexd"),
  targetID: TargetID,
}).annotate({ identifier: "Location.RexdTarget" })
export type RexdTarget = typeof RexdTarget.Type

export const Target = Schema.Union([LocalTarget, RexdTarget]).annotate({ identifier: "Location.Target" })
export type Target = typeof Target.Type

export interface Ref extends Schema.Schema.Type<typeof Ref> {}
export const Ref = Schema.Struct({
  target: Target.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({ type: "local" as const })),
    Schema.withConstructorDefault(Effect.succeed({ type: "local" as const })),
  ),
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceID),
  lastKnownTargetName: optional(Schema.String),
}).annotate({ identifier: "Location.Ref" })

export class Info extends Schema.Class<Info>("Location.Info")({
  target: optional(Target),
  directory: AbsolutePath,
  workspaceID: optional(WorkspaceID),
  lastKnownTargetName: optional(Schema.String),
  project: Schema.Struct({
    id: ProjectID,
    directory: AbsolutePath,
  }),
}) {}

export function response<S extends Schema.Top>(data: S) {
  return Schema.Struct({ location: Info, data })
}
