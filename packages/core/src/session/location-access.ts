export * as SessionLocationAccess from "./location-access"

import { Context, Effect, Layer, Schema } from "effect"
import { and, eq, isNotNull, isNull, or } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { EventSequenceTable } from "../event/sql"
import { Location } from "../location"
import { SessionLocationRebinding } from "../session-location-rebinding"
import { TargetBindingRegistry } from "../target-binding-registry"
import { TargetRegistry } from "../target-registry"
import { SessionSchema } from "./schema"
import { SessionTable } from "./sql"
import { SessionStore } from "./store"

const UnresolvedStatus = Schema.Literals([
  "missing_local_target",
  "unbound_portable_target",
  "target_unavailable",
  "resolution_failed",
])

export class UnresolvedError extends Schema.TaggedErrorClass<UnresolvedError>()(
  "SessionLocationAccess.UnresolvedError",
  {
    sessionID: SessionSchema.ID,
    status: UnresolvedStatus,
    stage: Schema.optional(Schema.String),
    message: Schema.String,
  },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("SessionLocationAccess.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export type Adapter = {
  readonly session: (sessionID: SessionSchema.ID) => Promise<SessionSchema.Info | undefined>
  readonly targets: () => Promise<readonly TargetRegistry.Definition[]>
  readonly bindings: () => Promise<ReadonlyMap<string, Location.TargetID>>
  readonly foreignOwner: (sessionID: SessionSchema.ID) => Promise<boolean>
  readonly referencedSessions: (reference: {
    readonly targetID?: Location.TargetID
    readonly label?: string
  }) => Promise<readonly SessionSchema.ID[]>
  readonly probe: (target: TargetRegistry.Definition, directory: string) => Promise<TargetRegistry.ProbeResult>
}

export type Interface = ReturnType<typeof make>
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionLocationAccess") {}

export function make(adapter: Adapter) {
  const resolve = Effect.fn("SessionLocationAccess.resolve")(function* (sessionID: SessionSchema.ID) {
    const session = yield* Effect.tryPromise({
      try: () => adapter.session(sessionID),
      catch: () => new UnresolvedError({ sessionID, status: "resolution_failed", message: "Session lookup failed" }),
    })
    if (!session) return yield* new NotFoundError({ sessionID })
    // Early sync projections kept the source device's target ID but lost its
    // portable label. Foreign ownership plus revision zero distinguishes that
    // legacy cloud placeholder from a locally removed or rebound target.
    const portableTargetLabel = session.portableTargetLabel
      ? session.portableTargetLabel
      : session.syncSpaceID &&
          session.locationRevision === 0 &&
          session.location.target.type === "rexd" &&
          session.location.lastKnownTargetName &&
          (yield* Effect.tryPromise({
            try: () => adapter.foreignOwner(sessionID),
            catch: () =>
              new UnresolvedError({ sessionID, status: "resolution_failed", message: "Session owner lookup failed" }),
          }))
        ? session.location.lastKnownTargetName
        : undefined
    return yield* Effect.tryPromise({
      try: async () =>
        SessionLocationRebinding.resolve({
          sessionID,
          location: session.location,
          portable: portableTargetLabel
            ? { label: portableTargetLabel, directory: session.location.directory }
            : undefined,
          targets: await adapter.targets(),
          bindings: await adapter.bindings(),
          referencedSessions: adapter.referencedSessions,
          probe: adapter.probe,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.catch(() =>
        Effect.succeed({ status: "resolution_failed" as const, message: "Session Location resolution failed" }),
      ),
    )
  })

  const require = Effect.fn("SessionLocationAccess.require")(function* (sessionID: SessionSchema.ID) {
    const resolution = yield* resolve(sessionID)
    if (resolution.status === "resolved") return resolution.location
    return yield* new UnresolvedError({
      sessionID,
      status: resolution.status,
      stage: resolution.status === "target_unavailable" ? resolution.stage : undefined,
      message:
        resolution.status === "target_unavailable"
          ? resolution.message
          : resolution.status === "missing_local_target"
            ? "Session target is not configured on this device"
            : resolution.status === "unbound_portable_target"
              ? "Portable Session target is not bound on this device"
              : resolution.message,
    })
  })

  return { resolve, require }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const store = yield* SessionStore.Service
    const targets = yield* TargetRegistry.Service
    const bindings = yield* TargetBindingRegistry.Service
    const db = (yield* Database.Service).db
    return Service.of(
      make({
        session: (sessionID) => Effect.runPromise(store.get(sessionID)),
        targets: async () => (await targets.load()).targets,
        bindings: async () => (await bindings.load()).bindings,
        foreignOwner: async (sessionID) =>
          Boolean(
            (
              await Effect.runPromise(
                db
                  .select({ ownerID: EventSequenceTable.owner_id })
                  .from(EventSequenceTable)
                  .where(eq(EventSequenceTable.aggregate_id, sessionID))
                  .get(),
              )
            )?.ownerID,
          ),
        referencedSessions: async (reference) => {
          const rows = await Effect.runPromise(
            db
              .select({
                id: SessionTable.id,
                target: SessionTable.target,
                portableTargetLabel: SessionTable.portable_target_label,
                lastKnownTargetName: SessionTable.last_known_target_name,
                syncSpaceID: SessionTable.sync_space_id,
                locationRevision: SessionTable.location_revision,
                ownerID: EventSequenceTable.owner_id,
              })
              .from(SessionTable)
              .leftJoin(EventSequenceTable, eq(EventSequenceTable.aggregate_id, SessionTable.id))
              .where(
                reference.label
                  ? or(
                      eq(SessionTable.portable_target_label, reference.label),
                      and(
                        isNull(SessionTable.portable_target_label),
                        eq(SessionTable.last_known_target_name, reference.label),
                        isNotNull(SessionTable.sync_space_id),
                        isNotNull(EventSequenceTable.owner_id),
                        eq(SessionTable.location_revision, 0),
                      ),
                    )
                  : undefined,
              ),
          )
          return rows
            .filter((row) =>
              reference.targetID
                ? row.target?.type === "rexd" && row.target.targetID === reference.targetID
                : row.portableTargetLabel === reference.label ||
                  (row.lastKnownTargetName === reference.label &&
                    Boolean(row.syncSpaceID) &&
                    Boolean(row.ownerID) &&
                    row.locationRevision === 0),
            )
            .map((row) => row.id)
        },
        probe: (target, directory) => targets.prepare(target.id, directory),
      }),
    )
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [SessionStore.node, TargetRegistry.node, TargetBindingRegistry.node, Database.node],
})
