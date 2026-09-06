import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906180254_session_location_revision",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`location_revision\` integer DEFAULT 0 NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
