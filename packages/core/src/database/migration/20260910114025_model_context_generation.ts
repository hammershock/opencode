import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260910114025_model_context_generation",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`generation\` integer DEFAULT 1 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`reason\` text DEFAULT 'legacy-backfill' NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`location_revision\` integer DEFAULT 0 NOT NULL;`)
      yield* tx.run(`ALTER TABLE \`session_context_epoch\` ADD \`digest\` text DEFAULT '' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
