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
  "resolution_failed",
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
  | {
      readonly status: "resolution_failed"
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

export type AccessMode = "read-write" | "read-only"

export type LocationOperation =
  | "history.read"
  | "metadata.read"
  | "prompt"
  | "user_shell"
  | "agent_tool"
  | "terminal"
  | "filesystem"
  | "location_mutation"

/**
 * The read-only unresolved-session gate is deliberately expressed in Core so
 * every client and every execution entry point uses the same deny-by-default
 * boundary. Merely hiding controls in the TUI is not a security boundary.
 */
export function permits(mode: AccessMode, operation: LocationOperation) {
  if (mode === "read-write") return true
  return operation === "history.read" || operation === "metadata.read"
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

export type RecoveryAdapter = {
  readonly referencedSessions: (reference: {
    readonly targetID?: Location.TargetID
    readonly portableTargetLabel?: string
  }) => Promise<readonly SessionSchema.ID[]>
  /** Validate without mutating the Session or target registry. */
  readonly validateTargetInput: (input: TargetRegistry.Input) => Promise<void>
  /** The only path allowed to restore a previously referenced target ID. */
  readonly restoreMissingTarget: (input: {
    readonly targetID: Location.TargetID
    readonly target: TargetRegistry.Input
    readonly referencedSessionIDs: readonly SessionSchema.ID[]
    readonly expectedRegistryRevision: string
  }) => Promise<TargetRegistry.Definition>
  readonly validateSessionLocation: (sessionID: SessionSchema.ID, location: Location.Ref) => Promise<void>
  readonly setPortableBinding: (input: {
    readonly portableTargetLabel: string
    readonly targetID: Location.TargetID
    readonly expectedRevision: string
  }) => Promise<{ readonly revision: string }>
  readonly readPortableBindingRevision: () => Promise<string>
  /** Checked before and after remote validation so an active Session never changes effective Location. */
  readonly assertSessionsIdle?: (sessionIDs: readonly SessionSchema.ID[]) => Promise<void>
  /** Writes the monotonic tombstone before local projection is removed. */
  readonly publishGlobalDeletion: (sessionID: SessionSchema.ID) => Promise<void>
  readonly removeLocalProjection: (sessionID: SessionSchema.ID) => Promise<void>
}

export class RecoveryScopeChangedError extends Schema.TaggedErrorClass<RecoveryScopeChangedError>()(
  "SessionLocationRebinding.RecoveryScopeChangedError",
  { expected: Schema.Array(SessionSchema.ID), actual: Schema.Array(SessionSchema.ID) },
) {}

export class RecoveryValidationError extends Schema.TaggedErrorClass<RecoveryValidationError>()(
  "SessionLocationRebinding.RecoveryValidationError",
  { failedSessionIDs: Schema.Array(SessionSchema.ID) },
) {}

export class BindingRevisionConflictError extends Schema.TaggedErrorClass<BindingRevisionConflictError>()(
  "SessionLocationRebinding.BindingRevisionConflictError",
  { expected: Schema.String, actual: Schema.String },
) {}

/** Registry repair, portable binding and global deletion workflows from RFC-0009. */
export function makeRecovery(adapter: RecoveryAdapter) {
  return {
    async restoreMissing(input: {
      readonly targetID: Location.TargetID
      readonly target: TargetRegistry.Input
      readonly expectedSessionIDs: readonly SessionSchema.ID[]
      readonly expectedRegistryRevision: string
      readonly locations: ReadonlyMap<SessionSchema.ID, Location.Ref>
    }) {
      const current = await adapter.referencedSessions({ targetID: input.targetID })
      requireSameScope(input.expectedSessionIDs, current)
      await adapter.validateTargetInput(input.target)
      const restored = await adapter.restoreMissingTarget({
        targetID: input.targetID,
        target: input.target,
        referencedSessionIDs: current,
        expectedRegistryRevision: input.expectedRegistryRevision,
      })
      const failures: SessionSchema.ID[] = []
      for (const sessionID of current) {
        const location = input.locations.get(sessionID)
        if (!location) {
          failures.push(sessionID)
          continue
        }
        try {
          await adapter.validateSessionLocation(sessionID, location)
        } catch {
          failures.push(sessionID)
        }
      }
      return {
        target: restored,
        resolvedSessionIDs: current.filter((id) => !failures.includes(id)),
        failedSessionIDs: failures,
      }
    },

    async bindPortable(input: {
      readonly portableTargetLabel: string
      readonly targetID: Location.TargetID
      readonly expectedSessionIDs: readonly SessionSchema.ID[]
      readonly expectedBindingRevision: string
      readonly locations: ReadonlyMap<SessionSchema.ID, Location.Ref>
    }) {
      const current = await adapter.referencedSessions({ portableTargetLabel: input.portableTargetLabel })
      requireSameScope(input.expectedSessionIDs, current)
      await adapter.assertSessionsIdle?.(current)
      const actualRevision = await adapter.readPortableBindingRevision()
      if (actualRevision !== input.expectedBindingRevision)
        throw new BindingRevisionConflictError({ expected: input.expectedBindingRevision, actual: actualRevision })
      // Validate every affected Session before publishing the device-local binding.
      const failures: SessionSchema.ID[] = []
      for (const sessionID of current) {
        const location = input.locations.get(sessionID)
        if (!location) {
          failures.push(sessionID)
          continue
        }
        try {
          await adapter.validateSessionLocation(sessionID, location)
        } catch {
          failures.push(sessionID)
        }
      }
      if (failures.length) throw new RecoveryValidationError({ failedSessionIDs: failures })
      await adapter.assertSessionsIdle?.(current)
      const result = await adapter.setPortableBinding({
        portableTargetLabel: input.portableTargetLabel,
        targetID: input.targetID,
        expectedRevision: input.expectedBindingRevision,
      })
      return { ...result, resolvedSessionIDs: current }
    },

    async deleteGlobally(sessionID: SessionSchema.ID) {
      // This ordering is what prevents a later download from resurrecting the Session.
      await adapter.publishGlobalDeletion(sessionID)
      await adapter.removeLocalProjection(sessionID)
    },
  }
}

export async function resolve(input: {
  readonly sessionID: SessionSchema.ID
  readonly location?: Location.Ref
  readonly portable?: { readonly label: string; readonly directory: string }
  readonly targets: readonly TargetRegistry.Definition[]
  readonly bindings: ReadonlyMap<string, Location.TargetID>
  readonly referencedSessions: (reference: {
    targetID?: Location.TargetID
    label?: string
  }) => Promise<readonly SessionSchema.ID[]>
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

function requireSameScope(expected: readonly SessionSchema.ID[], actual: readonly SessionSchema.ID[]) {
  const left = [...new Set(expected)].sort()
  const right = [...new Set(actual)].sort()
  if (left.length !== right.length || left.some((id, index) => id !== right[index]))
    throw new RecoveryScopeChangedError({ expected: left, actual: right })
}

function sameLocation(left: Location.Ref, right: Location.Ref) {
  return (
    left.directory === right.directory &&
    left.workspaceID === right.workspaceID &&
    left.target.type === right.target.type &&
    (left.target.type === "local" || (right.target.type === "rexd" && left.target.targetID === right.target.targetID))
  )
}
