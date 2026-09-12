import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260912054016_session-skill-guidance",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session_skill_catalog\` ADD \`guidance\` text;`)
    })
  },
} satisfies DatabaseMigration.Migration
