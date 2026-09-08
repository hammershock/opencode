export * as SyncMetadata from "./metadata"

import { Context, Effect, Layer, Schema } from "effect"
import { sql } from "drizzle-orm"
import { makeGlobalNode } from "../effect/app-node"
import { SyncDatabase } from "./database"
import { SyncRuntime } from "./runtime"
import { NonNegativeInt } from "../schema"

export const Availability = Schema.Literals([
  "metadata-only",
  "hydrating",
  "ready",
  "partial",
  "conflict",
  "unresolved",
])
export type Availability = typeof Availability.Type
export const Item = Schema.Struct({
  sessionID: Schema.NonEmptyString,
  title: Schema.String,
  ownerDeviceID: Schema.NonEmptyString,
  targetLabel: Schema.optional(Schema.String),
  directory: Schema.String,
  revision: NonNegativeInt,
  updatedAt: NonNegativeInt,
  deleted: Schema.optional(Schema.Boolean),
  sourceDeviceID: Schema.NonEmptyString,
  availability: Availability,
})
export type Item = typeof Item.Type

export interface Interface {
  readonly scope: (spaceID: string) => Interface
  readonly apply: (deviceID: string, values: readonly SyncRuntime.Metadata[]) => Effect.Effect<void, unknown>
  readonly retain: (sessionIDs: readonly string[]) => Effect.Effect<void, unknown>
  readonly list: () => Effect.Effect<readonly Item[], unknown>
  readonly availability: (sessionID: string, value: Availability) => Effect.Effect<void, unknown>
  readonly remove: (sessionID: string) => Effect.Effect<void, unknown>
  readonly clear: () => Effect.Effect<void, unknown>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncMetadata") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = (yield* SyncDatabase.Service).db
    const scoped = (spaceID: string): Interface => {
      const list = () =>
        db
          .all<{ payload: string; source_device: string; availability: Availability }>(
            sql`
        SELECT payload, source_device, availability FROM sync_session_metadata
        WHERE space_id = ${spaceID}
          AND NOT EXISTS (
            SELECT 1 FROM sync_deletion_set
            WHERE sync_deletion_set.space_id = sync_session_metadata.space_id
              AND sync_deletion_set.session_id = sync_session_metadata.session_id
          )
        ORDER BY updated_at DESC, session_id
      `,
          )
          .pipe(
            Effect.map((rows) =>
              rows.map((row) => ({
                ...Schema.decodeUnknownSync(SyncRuntime.Metadata)(JSON.parse(row.payload)),
                sourceDeviceID: row.source_device,
                availability: row.availability,
              })),
            ),
          )
      const apply = (deviceID: string, values: readonly SyncRuntime.Metadata[]) =>
        db.transaction((tx) =>
          Effect.forEach(
            values,
            (value) =>
              tx.run(sql`
        INSERT INTO sync_session_metadata (session_id, payload, source_device, revision, availability, updated_at, space_id)
        SELECT ${value.sessionID}, ${JSON.stringify(value)}, ${deviceID}, ${value.revision}, 'metadata-only', ${value.updatedAt}, ${spaceID}
        WHERE NOT EXISTS (
          SELECT 1 FROM sync_deletion_set WHERE session_id = ${value.sessionID} AND space_id = ${spaceID}
        )
        ON CONFLICT(space_id, session_id) DO UPDATE SET
          payload = CASE WHEN excluded.revision > revision OR (excluded.revision = revision AND excluded.source_device < source_device) THEN excluded.payload ELSE payload END,
          source_device = CASE WHEN excluded.revision > revision OR (excluded.revision = revision AND excluded.source_device < source_device) THEN excluded.source_device ELSE source_device END,
          revision = MAX(revision, excluded.revision),
          updated_at = MAX(updated_at, excluded.updated_at)
      `),
            { discard: true },
          ),
        )
      const retain = (sessionIDs: readonly string[]) =>
        db
          .run(
            sql`
            DELETE FROM sync_session_metadata
            WHERE space_id = ${spaceID}
              AND session_id NOT IN (SELECT value FROM json_each(${JSON.stringify(sessionIDs)}))
          `,
          )
          .pipe(Effect.asVoid)
      const availability = (sessionID: string, value: Availability) =>
        db
          .run(
            sql`UPDATE sync_session_metadata SET availability = ${value} WHERE session_id = ${sessionID} AND space_id = ${spaceID}`,
          )
          .pipe(Effect.asVoid)
      const remove = (sessionID: string) =>
        db
          .run(sql`DELETE FROM sync_session_metadata WHERE session_id = ${sessionID} AND space_id = ${spaceID}`)
          .pipe(Effect.asVoid)
      const clear = () => db.run(sql`DELETE FROM sync_session_metadata WHERE space_id = ${spaceID}`).pipe(Effect.asVoid)
      return { scope: scoped, apply, retain, list, availability, remove, clear }
    }
    return scoped("legacy")
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [SyncDatabase.node] })
