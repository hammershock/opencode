export * as SessionLocationRebinding from "./session-location-rebinding"

import { Schema } from "effect"
import { Location } from "./location"
import { SessionSchema } from "./session/schema"
import type { TargetRegistry } from "./target-registry"
import { AbsolutePath, NonNegativeInt } from "./schema"

export const ResolutionStatus = Schema.Literals([
  "resolved",
  "missing_local_target",
  "unbound_portable_target",
  "target_unavailable",
])
export type ResolutionStatus = typeof ResolutionStatus.Type

export const PortableTarget = Schema.Union([
  Schema.Struct({ type: Schema.Literal("local-owner") }),
  Schema.Struct({ type: Schema.Literal("label"), portableTargetLabel: Schema.String }),
])
export type PortableTarget = typeof PortableTarget.Type

export const PortableSessionLocation = Schema.Struct({
  revision: NonNegativeInt,
  target: PortableTarget,
  directory: Schema.String,
  updatedByDeviceID: Schema.String,
})
export type PortableSessionLocation = typeof PortableSessionLocation.Type

export type Resolution =
  | { readonly status: "resolved"; readonly location: Location.Ref; readonly target?: TargetRegistry.Definition }
  | {
      readonly status: "missing_local_target"
      readonly location: Location.Ref
      readonly missingTargetID: Location.TargetID
      readonly lastKnownTargetName?: string
      readonly referencedSessionIDs: readonly SessionSchema.ID[]
    }
  | {
      readonly status: "unbound_portable_target"
      readonly portableTargetLabel: string
      readonly directory: string
      readonly referencedSessionIDs: readonly SessionSchema.ID[]
    }
  | {
      readonly status: "target_unavailable"
      readonly location: Location.Ref
      readonly target: TargetRegistry.Definition
      readonly stage: TargetRegistry.ConnectionStage
      readonly message: string
    }

export type Blocker =
  | "agent_turn"
  | "queued_turn"
  | "tool_execution"
  | "process_execution"
  | "user_shell"
  | "permission"
  | "question"
  | "terminal_pty"
  | "session_mutation"
  | "location_rebind"
  | "sync_replay"

export type Record = {
  readonly sessionID: SessionSchema.ID
  readonly location: Location.Ref
  readonly locationRevision: number
}

export type Candidate = {
  readonly location: Location.Ref
  readonly preparedEnvironment: unknown
}

export interface Adapter {
  readonly withMutationLock: <A>(sessionID: SessionSchema.ID, run: () => Promise<A>) => Promise<A>
  readonly read: (sessionID: SessionSchema.ID) => Promise<Record | undefined>
  readonly blockers: (sessionID: SessionSchema.ID) => Promise<readonly Blocker[]>
  readonly validateCandidate: (location: Location.Ref) => Promise<Candidate>
  readonly commit: (input: {
    readonly sessionID: SessionSchema.ID
    readonly expectedRevision: number
    readonly previous: Location.Ref
    readonly candidate: Candidate
  }) => Promise<{ readonly revision: number }>
  readonly invalidateRuntime: (input: {
    readonly sessionID: SessionSchema.ID
    readonly previous: Location.Ref
    readonly candidate: Candidate
  }) => Promise<readonly string[]>
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionLocationRebinding.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "SessionLocationRebinding.RevisionConflictError",
  { expected: NonNegativeInt, actual: NonNegativeInt },
) {}

export class SessionNotIdleError extends Schema.TaggedErrorClass<SessionNotIdleError>()(
  "SessionLocationRebinding.SessionNotIdleError",
  { blockers: Schema.Array(Schema.String) },
) {}

export function make(adapter: Adapter) {
  return {
    rebind(input: { sessionID: SessionSchema.ID; expectedRevision: number; destination: Location.Ref }) {
      return adapter.withMutationLock(input.sessionID, async () => {
        const before = await adapter.read(input.sessionID)
        if (!before) throw new NotFoundError({ sessionID: input.sessionID })
        requireRevision(input.expectedRevision, before.locationRevision)
        const blockers = await adapter.blockers(input.sessionID)
        if (blockers.length) throw new SessionNotIdleError({ blockers: [...blockers] })
        if (sameLocation(before.location, input.destination))
          return { status: "unchanged" as const, revision: before.locationRevision, warnings: [] as readonly string[] }

        const candidate = await adapter.validateCandidate(input.destination)
        const current = await adapter.read(input.sessionID)
        if (!current) throw new NotFoundError({ sessionID: input.sessionID })
        requireRevision(input.expectedRevision, current.locationRevision)
        const finalBlockers = await adapter.blockers(input.sessionID)
        if (finalBlockers.length) throw new SessionNotIdleError({ blockers: [...finalBlockers] })
        const committed = await adapter.commit({
          sessionID: input.sessionID,
          expectedRevision: input.expectedRevision,
          previous: current.location,
          candidate,
        })
        const warnings = await adapter.invalidateRuntime({
          sessionID: input.sessionID,
          previous: current.location,
          candidate,
        })
        return { status: "rebound" as const, revision: committed.revision, warnings }
      })
    },
  }
}

export async function resolve(input: {
  readonly sessionID: SessionSchema.ID
  readonly location?: Location.Ref
  readonly portable?: { readonly label: string; readonly directory: string }
  readonly targets: readonly TargetRegistry.Definition[]
  readonly bindings: ReadonlyMap<string, Location.TargetID>
  readonly referencedSessions: (reference: { targetID?: Location.TargetID; label?: string }) => Promise<readonly SessionSchema.ID[]>
  readonly probe: (target: TargetRegistry.Definition, directory: string) => Promise<TargetRegistry.ProbeResult>
}): Promise<Resolution> {
  if (input.portable) {
    const targetID = input.bindings.get(input.portable.label)
    if (!targetID)
      return {
        status: "unbound_portable_target",
        portableTargetLabel: input.portable.label,
        directory: AbsolutePath.make(input.portable.directory),
        referencedSessionIDs: await input.referencedSessions({ label: input.portable.label }),
      }
    return resolveLocation(
      Location.Ref.make({
        target: { type: "rexd", targetID },
        directory: AbsolutePath.make(input.portable.directory),
        lastKnownTargetName: input.portable.label,
      }),
      input,
    )
  }
  if (!input.location) throw new NotFoundError({ sessionID: input.sessionID })
  return resolveLocation(input.location, input)
}

async function resolveLocation(location: Location.Ref, input: Parameters<typeof resolve>[0]): Promise<Resolution> {
  if (location.target.type === "local") return { status: "resolved", location }
  const targetID = location.target.targetID
  const target = input.targets.find((item) => item.id === targetID)
  if (!target)
    return {
      status: "missing_local_target",
      location,
      missingTargetID: targetID,
      lastKnownTargetName: location.lastKnownTargetName,
      referencedSessionIDs: await input.referencedSessions({ targetID }),
    }
  const probe = await input.probe(target, location.directory)
  if (probe.status === "ready") return { status: "resolved", location, target }
  return { status: "target_unavailable", location, target, stage: probe.stage, message: probe.message }
}

function requireRevision(expected: number, actual: number) {
  if (expected !== actual) throw new RevisionConflictError({ expected, actual })
}

function sameLocation(left: Location.Ref, right: Location.Ref) {
  return (
    left.directory === right.directory &&
    left.workspaceID === right.workspaceID &&
    left.target.type === right.target.type &&
    (left.target.type === "local" || (right.target.type === "rexd" && left.target.targetID === right.target.targetID))
  )
}
