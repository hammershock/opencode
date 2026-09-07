import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907090000_session_sync_space",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`sync_space_id\` text;`)
      yield* tx.run(`CREATE INDEX \`session_sync_space_idx\` ON \`session\` (\`sync_space_id\`, \`time_updated\`);`)
    })
  },
} satisfies DatabaseMigration.Migration
