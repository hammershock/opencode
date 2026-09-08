export * as SyncMembership from "./membership"

import { Context, Effect, Layer } from "effect"
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import { Database } from "../database/database"
import { makeGlobalNode } from "../effect/app-node"
import { SessionTable } from "../session/sql"
import { SyncEventStore } from "./event-store"
import { SyncOwnership } from "./ownership"
import { SessionSync } from "./session"
import { SessionV2 } from "../session"

export interface Interface {
  readonly unassigned: () => Effect.Effect<readonly string[], unknown>
  readonly assignUnassigned: (
    sessionIDs: readonly string[],
    spaceID: string,
  ) => Effect.Effect<readonly string[], unknown>
  readonly assignAll: (spaceID: string) => Effect.Effect<readonly string[], unknown>
  readonly unassignSpace: (spaceID: string) => Effect.Effect<readonly string[], unknown>
  readonly unassignAll: () => Effect.Effect<readonly string[], unknown>
  readonly reconcile: (validSpaceIDs: ReadonlySet<string>) => Effect.Effect<readonly string[], unknown>
  readonly stale: (validSpaceIDs: ReadonlySet<string>) => Effect.Effect<readonly string[], unknown>
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
    const assignUnassigned = Effect.fn("SyncMembership.assignUnassigned")(function* (
      sessionIDs: readonly string[],
      spaceID: string,
    ) {
      if (!sessionIDs.length) return []
      const rows = yield* db
        .update(SessionTable)
        .set({ sync_space_id: spaceID, time_updated: sql`${SessionTable.time_updated}` })
        .where(
          and(
            inArray(
              SessionTable.id,
              sessionIDs.map((sessionID) => SessionV2.ID.make(sessionID)),
            ),
            isNull(SessionTable.sync_space_id),
          ),
        )
        .returning({ id: SessionTable.id })
        .all()
      const ids = rows.map((row) => String(row.id))
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
    const assignAll = Effect.fn("SyncMembership.assignAll")(function* (spaceID: string) {
      const rows = yield* db.select({ id: SessionTable.id }).from(SessionTable).all()
      const ids = rows.map((row) => String(row.id))
      const existing = yield* ownership.list()
      yield* db
        .update(SessionTable)
        .set({ sync_space_id: spaceID, time_updated: sql`${SessionTable.time_updated}` })
        .run()
      yield* Effect.forEach(
        existing.filter((item) => item.spaceID !== spaceID),
        (item) => ownership.unassign(item.sessionID),
        { discard: true },
      )
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
    const stale = Effect.fn("SyncMembership.stale")(function* (validSpaceIDs: ReadonlySet<string>) {
      const rows = yield* db
        .select({ spaceID: SessionTable.sync_space_id })
        .from(SessionTable)
        .where(isNotNull(SessionTable.sync_space_id))
        .all()
      return staleSpaces(
        yield* ownership.list(),
        validSpaceIDs,
        rows.flatMap((row) => (row.spaceID ? [row.spaceID] : [])),
      )
    })
    const reconcile = Effect.fn("SyncMembership.reconcile")(function* (validSpaceIDs: ReadonlySet<string>) {
      const spaces = yield* stale(validSpaceIDs)
      return (yield* Effect.forEach(spaces, unassignSpace)).flat()
    })
    return Service.of({ unassigned, assignUnassigned, assignAll, unassignSpace, unassignAll, reconcile, stale })
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Database.node, SyncEventStore.node, SyncOwnership.node],
})

export function staleSpaces(
  ownership: readonly SyncOwnership.Item[],
  validSpaceIDs: ReadonlySet<string>,
  sessionSpaceIDs: readonly string[] = [],
) {
  return [
    ...new Set(
      [...ownership.map((item) => item.spaceID), ...sessionSpaceIDs].filter((spaceID) => !validSpaceIDs.has(spaceID)),
    ),
  ].sort()
}
