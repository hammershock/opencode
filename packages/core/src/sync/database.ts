export * as SyncDatabase from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Context, Effect, Layer } from "effect"
import { layer as sqliteLayer } from "#sqlite"
import { sql } from "drizzle-orm"
import { Global } from "../global"
import { makeGlobalNode } from "../effect/app-node"
import path from "node:path"
import fs from "node:fs/promises"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type Shape = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: Shape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncDatabase") {}

const schemaVersion = 6

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const db = yield* makeDatabase
    yield* db.run("PRAGMA journal_mode = WAL")
    yield* db.run("PRAGMA synchronous = NORMAL")
    yield* db.run("PRAGMA busy_timeout = 5000")
    yield* db.transaction(
      (tx) =>
        Effect.gen(function* () {
          yield* tx.run(sql`CREATE TABLE IF NOT EXISTS sync_schema (version INTEGER PRIMARY KEY)`)
          const current = yield* tx.get<{ version: number }>(sql`SELECT version FROM sync_schema ORDER BY version DESC`)
          if (current && current.version > schemaVersion)
            return yield* Effect.die(new Error(`Unsupported sync database schema ${current.version}`))
          if (!current) {
            yield* Effect.forEach(schemaV1, (statement) => tx.run(statement), { discard: true })
            yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (1)`)
          }
          if ((current?.version ?? 1) < 2) {
            yield* Effect.forEach(schemaV2, (statement) => tx.run(statement), { discard: true })
            yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (2)`)
          }
          if ((current?.version ?? 1) < 3) {
            yield* Effect.forEach(schemaV3, (statement) => tx.run(statement), { discard: true })
            yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (3)`)
          }
          if ((current?.version ?? 1) < 4) {
            yield* Effect.forEach(schemaV4, (statement) => tx.run(statement), { discard: true })
            yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (4)`)
          }
          if ((current?.version ?? 1) < 5) {
            yield* Effect.forEach(schemaV5, (statement) => tx.run(statement), { discard: true })
            yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (5)`)
          }
          if ((current?.version ?? 1) < 6) {
            yield* Effect.forEach(schemaV6, (statement) => tx.run(statement), { discard: true })
            yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (6)`)
          }
        }),
      { behavior: "immediate" },
    )
    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return Layer.unwrap(
    Effect.promise(async () => {
      await fs.mkdir(path.dirname(filename), { recursive: true })
      return layer.pipe(Layer.provide(sqliteLayer({ filename })))
    }),
  )
}

export function purgeSpace(db: Interface["db"], spaceID: string) {
  return db.transaction((tx) =>
    Effect.forEach(
      [
        sql`DELETE FROM sync_event_outbox WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_event_segment WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_event_head WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_event_cursor WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_remote_segment WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_remote_event WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_deletion_set WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_apply_journal WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_session_metadata WHERE space_id = ${spaceID}`,
        sql`DELETE FROM sync_session_space WHERE space_id = ${spaceID}`,
      ],
      (statement) => tx.run(statement),
      { discard: true },
    ).pipe(
      Effect.andThen(
        tx.run(sql`DELETE FROM sync_event_lease WHERE substr(name, 1, length(${`${spaceID}:`})) = ${`${spaceID}:`}`),
      ),
    ),
  )
}

const nodeLayer = Layer.unwrap(
  Effect.map(Global.Service, (global) => layerFromPath(path.join(global.config, "sync", "sync.db"))),
)

export const node = makeGlobalNode({ service: Service, layer: nodeLayer, deps: [Global.node] })

const schemaV1 = [
  sql`CREATE TABLE sync_event_outbox (
    event_id TEXT PRIMARY KEY, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, segment_id TEXT
  )`,
  sql`CREATE TABLE sync_event_segment (
    id TEXT PRIMARY KEY, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER,
    UNIQUE(device_id, generation)
  )`,
  sql`CREATE TABLE sync_event_head (device_id TEXT PRIMARY KEY, generation INTEGER NOT NULL)`,
  sql`CREATE TABLE sync_event_cursor (device_id TEXT PRIMARY KEY, cursor INTEGER NOT NULL)`,
  sql`CREATE TABLE sync_remote_segment (
    device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(device_id, generation)
  )`,
  sql`CREATE TABLE sync_remote_event (
    device_id TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY(device_id, event_id)
  )`,
  sql`CREATE TABLE sync_event_lease (name TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  sql`CREATE TRIGGER sync_event_segment_immutable
    BEFORE UPDATE OF device_id, generation, payload, created_at ON sync_event_segment
    BEGIN SELECT RAISE(ABORT, 'sync event segments are immutable'); END`,
]

const schemaV2 = [
  sql`ALTER TABLE sync_event_outbox ADD COLUMN kind TEXT NOT NULL DEFAULT 'event'`,
  sql`CREATE TABLE sync_deletion_set (
    session_id TEXT PRIMARY KEY, marker TEXT NOT NULL, deleted_at INTEGER NOT NULL
  )`,
]

const schemaV3 = [
  sql`CREATE TABLE sync_apply_journal (
    device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(device_id, generation)
  )`,
]

const schemaV4 = [
  sql`CREATE TABLE sync_session_metadata (
    session_id TEXT PRIMARY KEY, payload TEXT NOT NULL, source_device TEXT NOT NULL,
    revision INTEGER NOT NULL, availability TEXT NOT NULL, updated_at INTEGER NOT NULL
  )`,
]

const schemaV5 = [
  sql`ALTER TABLE sync_event_outbox ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_event_segment ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_event_head ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_event_cursor ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_remote_segment ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_remote_event ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_deletion_set ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_apply_journal ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`ALTER TABLE sync_session_metadata ADD COLUMN space_id TEXT NOT NULL DEFAULT 'legacy'`,
  sql`CREATE TABLE sync_session_space (
    session_id TEXT PRIMARY KEY, space_id TEXT NOT NULL, assigned_at INTEGER NOT NULL
  )`,
  sql`CREATE INDEX sync_event_outbox_space_idx ON sync_event_outbox(space_id, segment_id, created_at)`,
  sql`CREATE INDEX sync_event_segment_space_idx ON sync_event_segment(space_id, device_id, generation)`,
  sql`CREATE INDEX sync_event_cursor_space_idx ON sync_event_cursor(space_id, device_id)`,
  sql`CREATE INDEX sync_session_space_space_idx ON sync_session_space(space_id, session_id)`,
]

// v5 added space_id filters without changing the legacy global keys. Rebuild the
// scoped tables so the same device, generation, event, or Session can exist in
// independent spaces. All statements run in the database migration transaction.
const schemaV6 = [
  sql`DROP TRIGGER IF EXISTS sync_event_segment_immutable`,
  sql`DROP INDEX IF EXISTS sync_event_outbox_space_idx`,
  sql`DROP INDEX IF EXISTS sync_event_segment_space_idx`,
  sql`DROP INDEX IF EXISTS sync_event_cursor_space_idx`,

  sql`ALTER TABLE sync_event_outbox RENAME TO sync_event_outbox_v5`,
  sql`CREATE TABLE sync_event_outbox (
    event_id TEXT NOT NULL, aggregate_id TEXT NOT NULL, seq INTEGER NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, segment_id TEXT,
    kind TEXT NOT NULL DEFAULT 'event', space_id TEXT NOT NULL DEFAULT 'legacy',
    PRIMARY KEY(space_id, event_id)
  )`,
  sql`INSERT INTO sync_event_outbox
    (event_id, aggregate_id, seq, payload, created_at, segment_id, kind, space_id)
    SELECT event_id, aggregate_id, seq, payload, created_at, segment_id, kind, space_id
    FROM sync_event_outbox_v5`,
  sql`DROP TABLE sync_event_outbox_v5`,

  sql`ALTER TABLE sync_event_segment RENAME TO sync_event_segment_v5`,
  sql`CREATE TABLE sync_event_segment (
    id TEXT NOT NULL, device_id TEXT NOT NULL, generation INTEGER NOT NULL,
    payload TEXT NOT NULL, created_at INTEGER NOT NULL, acknowledged_at INTEGER,
    space_id TEXT NOT NULL DEFAULT 'legacy',
    PRIMARY KEY(space_id, id), UNIQUE(space_id, device_id, generation)
  )`,
  sql`INSERT INTO sync_event_segment
    (id, device_id, generation, payload, created_at, acknowledged_at, space_id)
    SELECT id, device_id, generation, payload, created_at, acknowledged_at, space_id
    FROM sync_event_segment_v5`,
  sql`DROP TABLE sync_event_segment_v5`,

  sql`ALTER TABLE sync_event_head RENAME TO sync_event_head_v5`,
  sql`CREATE TABLE sync_event_head (
    device_id TEXT NOT NULL, generation INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy',
    PRIMARY KEY(space_id, device_id)
  )`,
  sql`INSERT INTO sync_event_head (device_id, generation, space_id)
    SELECT device_id, generation, space_id FROM sync_event_head_v5`,
  sql`DROP TABLE sync_event_head_v5`,

  sql`ALTER TABLE sync_event_cursor RENAME TO sync_event_cursor_v5`,
  sql`CREATE TABLE sync_event_cursor (
    device_id TEXT NOT NULL, cursor INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy',
    PRIMARY KEY(space_id, device_id)
  )`,
  sql`INSERT INTO sync_event_cursor (device_id, cursor, space_id)
    SELECT device_id, cursor, space_id FROM sync_event_cursor_v5`,
  sql`DROP TABLE sync_event_cursor_v5`,

  sql`ALTER TABLE sync_remote_segment RENAME TO sync_remote_segment_v5`,
  sql`CREATE TABLE sync_remote_segment (
    device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
    space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(space_id, device_id, generation)
  )`,
  sql`INSERT INTO sync_remote_segment (device_id, generation, payload, space_id)
    SELECT device_id, generation, payload, space_id FROM sync_remote_segment_v5`,
  sql`DROP TABLE sync_remote_segment_v5`,

  sql`ALTER TABLE sync_remote_event RENAME TO sync_remote_event_v5`,
  sql`CREATE TABLE sync_remote_event (
    device_id TEXT NOT NULL, event_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(space_id, device_id, event_id)
  )`,
  sql`INSERT INTO sync_remote_event (device_id, event_id, fingerprint, space_id)
    SELECT device_id, event_id, fingerprint, space_id FROM sync_remote_event_v5`,
  sql`DROP TABLE sync_remote_event_v5`,

  sql`ALTER TABLE sync_deletion_set RENAME TO sync_deletion_set_v5`,
  sql`CREATE TABLE sync_deletion_set (
    session_id TEXT NOT NULL, marker TEXT NOT NULL, deleted_at INTEGER NOT NULL,
    space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(space_id, session_id)
  )`,
  sql`INSERT INTO sync_deletion_set (session_id, marker, deleted_at, space_id)
    SELECT session_id, marker, deleted_at, space_id FROM sync_deletion_set_v5`,
  sql`DROP TABLE sync_deletion_set_v5`,

  sql`ALTER TABLE sync_apply_journal RENAME TO sync_apply_journal_v5`,
  sql`CREATE TABLE sync_apply_journal (
    device_id TEXT NOT NULL, generation INTEGER NOT NULL, payload TEXT NOT NULL,
    created_at INTEGER NOT NULL, space_id TEXT NOT NULL DEFAULT 'legacy',
    PRIMARY KEY(space_id, device_id, generation)
  )`,
  sql`INSERT INTO sync_apply_journal (device_id, generation, payload, created_at, space_id)
    SELECT device_id, generation, payload, created_at, space_id FROM sync_apply_journal_v5`,
  sql`DROP TABLE sync_apply_journal_v5`,

  sql`ALTER TABLE sync_session_metadata RENAME TO sync_session_metadata_v5`,
  sql`CREATE TABLE sync_session_metadata (
    session_id TEXT NOT NULL, payload TEXT NOT NULL, source_device TEXT NOT NULL,
    revision INTEGER NOT NULL, availability TEXT NOT NULL, updated_at INTEGER NOT NULL,
    space_id TEXT NOT NULL DEFAULT 'legacy', PRIMARY KEY(space_id, session_id)
  )`,
  sql`INSERT INTO sync_session_metadata
    (session_id, payload, source_device, revision, availability, updated_at, space_id)
    SELECT session_id, payload, source_device, revision, availability, updated_at, space_id
    FROM sync_session_metadata_v5`,
  sql`DROP TABLE sync_session_metadata_v5`,

  sql`CREATE TRIGGER sync_event_segment_immutable
    BEFORE UPDATE OF device_id, generation, payload, created_at, space_id ON sync_event_segment
    BEGIN SELECT RAISE(ABORT, 'sync event segments are immutable'); END`,
  sql`CREATE INDEX sync_event_outbox_space_idx ON sync_event_outbox(space_id, segment_id, created_at)`,
  sql`CREATE INDEX sync_event_segment_space_idx ON sync_event_segment(space_id, device_id, generation)`,
  sql`CREATE INDEX sync_event_cursor_space_idx ON sync_event_cursor(space_id, device_id)`,
]
