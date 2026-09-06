import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907023000_session_portable_target_label",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`portable_target_label\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
