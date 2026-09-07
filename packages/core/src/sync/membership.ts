export * as SyncMembership from "./membership"

import { Context, Effect, Layer } from "effect"
import { eq, isNull, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionTable } from "../session/sql"
import { SyncEventStore } from "./event-store"
import { SyncOwnership } from "./ownership"
import { SessionSync } from "./session"

export interface Interface {
  readonly unassigned: () => Effect.Effect<readonly string[], unknown>
  readonly assignAll: (spaceID: string) => Effect.Effect<readonly string[], unknown>
  readonly unassignSpace: (spaceID: string) => Effect.Effect<readonly string[], unknown>
  readonly unassignAll: () => Effect.Effect<readonly string[], unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncMembership") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* Database.Service).db
    const store = yield* SyncEventStore.Service
    const ownership = yield* SyncOwnership.Service
    const unassigned = () =>
      db
        .select({ id: SessionTable.id })
        .from(SessionTable)
        .where(isNull(SessionTable.sync_space_id))
        .all()
        .pipe(Effect.map((rows) => rows.map((row) => String(row.id))))
    const assignAll = Effect.fn("SyncMembership.assignAll")(function* (spaceID: string) {
      const ids = yield* unassigned()
      if (!ids.length) return ids
      yield* db
        .update(SessionTable)
        .set({ sync_space_id: spaceID, time_updated: sql`${SessionTable.time_updated}` })
        .where(isNull(SessionTable.sync_space_id))
        .run()
      yield* Effect.forEach(
        ids,
        (sessionID) =>
          ownership
            .assign(sessionID, spaceID)
            .pipe(Effect.andThen(SessionSync.backfill(db, store, sessionID, spaceID))),
        { discard: true },
      )
      return ids
    })
    const unassignSpace = Effect.fn("SyncMembership.unassignSpace")(function* (spaceID: string) {
      const ids = (yield* ownership.list(spaceID)).map((item) => item.sessionID)
      yield* db
        .update(SessionTable)
        .set({ sync_space_id: null, time_updated: sql`${SessionTable.time_updated}` })
        .where(eq(SessionTable.sync_space_id, spaceID))
        .run()
      yield* ownership.unassignSpace(spaceID)
      return ids
    })
    const unassignAll = Effect.fn("SyncMembership.unassignAll")(function* () {
      const ids = (yield* ownership.list()).map((item) => item.sessionID)
      yield* db
        .update(SessionTable)
        .set({ sync_space_id: null, time_updated: sql`${SessionTable.time_updated}` })
        .run()
      yield* Effect.forEach(ids, ownership.unassign, { discard: true })
      return ids
    })
    return Service.of({ unassigned, assignAll, unassignSpace, unassignAll })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SyncEventStore.node, SyncOwnership.node],
})
