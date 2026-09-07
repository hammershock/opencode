export * as Session from "./session"

import { Effect, Schema } from "effect"
import { Agent } from "./agent"
import { Location } from "./location"
import { Model } from "./model"
import { Project } from "./project"
import { DateTimeUtcFromMillis, NonNegativeInt, optional, RelativePath } from "./schema"
import { SessionEvent } from "./session-event"
import { SessionID } from "./session-id"
import { Revert } from "./revert"
import { ApprovalMode } from "./approval-mode"

export const ID = SessionID
export type ID = SessionID

export const Event = SessionEvent

export interface Info extends Schema.Schema.Type<typeof Info> {}
export const Info = Schema.Struct({
  id: ID,
  parentID: ID.pipe(optional),
  projectID: Project.ID,
  agent: Agent.ID.pipe(optional),
  model: Model.Ref.pipe(optional),
  cost: Schema.Finite,
  tokens: Schema.Struct({
    input: Schema.Finite,
    output: Schema.Finite,
    reasoning: Schema.Finite,
    cache: Schema.Struct({
      read: Schema.Finite,
      write: Schema.Finite,
    }),
  }),
  time: Schema.Struct({
    created: DateTimeUtcFromMillis,
    updated: DateTimeUtcFromMillis,
    archived: DateTimeUtcFromMillis.pipe(optional),
  }),
  title: Schema.String,
  approvalMode: ApprovalMode.Mode.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("normal" as const)),
    Schema.withConstructorDefault(Effect.succeed("normal" as const)),
  ),
  location: Location.Ref,
  locationRevision: NonNegativeInt.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(0)),
    Schema.withConstructorDefault(Effect.succeed(0)),
  ),
  /** Synchronized logical target identity; never contains a device-local target ID or connection data. */
  portableTargetLabel: Schema.String.pipe(optional),
  subpath: RelativePath.pipe(optional),
  revert: Revert.State.pipe(optional),
}).annotate({ identifier: "SessionV2.Info" })

export const ListAnchor = Schema.Struct({
  id: ID,
  time: Schema.Finite,
  direction: Schema.Literals(["previous", "next"]),
}).annotate({ identifier: "Session.ListAnchor" })
export interface ListAnchor extends Schema.Schema.Type<typeof ListAnchor> {}
