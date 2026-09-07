export * as SyncOwnership from "./ownership"

import { Context, Effect, Layer } from "effect"
import { sql } from "drizzle-orm"
import { makeGlobalNode } from "../effect/app-node"
import { SyncDatabase } from "./database"

export type Item = {
  readonly sessionID: string
  readonly spaceID: string
  readonly assignedAt: number
}

export interface Interface {
  readonly get: (sessionID: string) => Effect.Effect<Item | undefined, unknown>
  readonly list: (spaceID?: string) => Effect.Effect<readonly Item[], unknown>
  readonly assign: (sessionID: string, spaceID: string, assignedAt?: number) => Effect.Effect<void, unknown>
  readonly unassign: (sessionID: string) => Effect.Effect<void, unknown>
  readonly unassignSpace: (spaceID: string) => Effect.Effect<readonly string[], unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncOwnership") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* SyncDatabase.Service).db
    const get = Effect.fn("SyncOwnership.get")(function* (sessionID: string) {
      const row = yield* db.get<{ session_id: string; space_id: string; assigned_at: number }>(sql`
        SELECT session_id, space_id, assigned_at FROM sync_session_space WHERE session_id = ${sessionID}
      `)
      return row ? { sessionID: row.session_id, spaceID: row.space_id, assignedAt: row.assigned_at } : undefined
    })
    const list = Effect.fn("SyncOwnership.list")(function* (spaceID?: string) {
      const rows = spaceID
        ? yield* db.all<{ session_id: string; space_id: string; assigned_at: number }>(sql`
            SELECT session_id, space_id, assigned_at FROM sync_session_space
            WHERE space_id = ${spaceID} ORDER BY assigned_at, session_id
          `)
        : yield* db.all<{ session_id: string; space_id: string; assigned_at: number }>(sql`
            SELECT session_id, space_id, assigned_at FROM sync_session_space ORDER BY assigned_at, session_id
          `)
      return rows.map((row) => ({ sessionID: row.session_id, spaceID: row.space_id, assignedAt: row.assigned_at }))
    })
    const assign = Effect.fn("SyncOwnership.assign")(function* (
      sessionID: string,
      spaceID: string,
      assignedAt = Date.now(),
    ) {
      yield* db.run(sql`
        INSERT INTO sync_session_space (session_id, space_id, assigned_at)
        VALUES (${sessionID}, ${spaceID}, ${assignedAt})
        ON CONFLICT(session_id) DO UPDATE SET space_id = excluded.space_id, assigned_at = excluded.assigned_at
      `)
    })
    const unassign = Effect.fn("SyncOwnership.unassign")(function* (sessionID: string) {
      yield* db.run(sql`DELETE FROM sync_session_space WHERE session_id = ${sessionID}`)
    })
    const unassignSpace = Effect.fn("SyncOwnership.unassignSpace")(function* (spaceID: string) {
      const rows = yield* list(spaceID)
      yield* db.run(sql`DELETE FROM sync_session_space WHERE space_id = ${spaceID}`)
      return rows.map((row) => row.sessionID)
    })
    return Service.of({ get: (sessionID) => get(sessionID), list, assign, unassign, unassignSpace })
  }).pipe(Effect.orDie),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SyncDatabase.node] })
