import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260906155032_add-session-target",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`target\` text;`)
      yield* tx.run(`ALTER TABLE \`session\` ADD \`last_known_target_name\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
