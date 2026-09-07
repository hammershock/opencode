export * as SessionLocationAccess from "./location-access"

import { Context, Effect, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
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
    return yield* Effect.tryPromise({
      try: async () =>
        SessionLocationRebinding.resolve({
          sessionID,
          location: session.location,
          portable: session.portableTargetLabel
            ? { label: session.portableTargetLabel, directory: session.location.directory }
            : undefined,
          targets: await adapter.targets(),
          bindings: await adapter.bindings(),
          referencedSessions: adapter.referencedSessions,
          probe: adapter.probe,
        }),
      catch: () =>
        new UnresolvedError({
          sessionID,
          status: "resolution_failed",
          message: "Session Location resolution failed",
        }),
    })
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
            : "Portable Session target is not bound on this device",
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
        referencedSessions: async (reference) => {
          const rows = await Effect.runPromise(
            db
              .select({
                id: SessionTable.id,
                target: SessionTable.target,
                portableTargetLabel: SessionTable.portable_target_label,
              })
              .from(SessionTable)
              .where(reference.label ? eq(SessionTable.portable_target_label, reference.label) : undefined),
          )
          return rows
            .filter((row) =>
              reference.targetID
                ? row.target?.type === "rexd" && row.target.targetID === reference.targetID
                : row.portableTargetLabel === reference.label,
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
