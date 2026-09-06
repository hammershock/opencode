import { Effect, Layer } from "effect"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"

const [filename, owner, timestamp] = process.argv.slice(2)
if (!filename || !owner || !timestamp) throw new Error("usage: sync-lease-worker <database> <owner> <timestamp>")
const database = SyncDatabase.layerFromPath(filename)
const acquired = await Effect.runPromise(
  Effect.gen(function* () {
    return yield* (yield* SyncEventStore.Service).acquire("process-boundary", owner, 100, Number(timestamp))
  }).pipe(Effect.scoped, Effect.provide(Layer.provideMerge(SyncEventStore.layer, database))),
)
process.stdout.write(JSON.stringify({ acquired }))
