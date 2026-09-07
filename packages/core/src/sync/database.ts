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

const schemaVersion = 5

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
