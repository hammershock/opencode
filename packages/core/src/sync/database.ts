export * as SyncDatabase from "./database"

import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { Context, Effect, Layer } from "effect"
import { layer as sqliteLayer } from "#sqlite"
import { sql } from "drizzle-orm"

const makeDatabase = EffectDrizzleSqlite.makeWithDefaults()
type Shape = Effect.Success<typeof makeDatabase>

export interface Interface {
  readonly db: Shape
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SyncDatabase") {}

const schemaVersion = 1

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
          if (current?.version === schemaVersion) return
          yield* Effect.forEach(schema, (statement) => tx.run(statement), { discard: true })
          yield* tx.run(sql`INSERT INTO sync_schema (version) VALUES (${schemaVersion})`)
        }),
      { behavior: "immediate" },
    )
    return { db }
  }).pipe(Effect.orDie),
)

export function layerFromPath(filename: string) {
  return layer.pipe(Layer.provide(sqliteLayer({ filename })))
}

const schema = [
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
