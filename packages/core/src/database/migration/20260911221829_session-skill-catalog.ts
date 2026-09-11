import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260911221829_session-skill-catalog",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`
        CREATE TABLE \`session_skill_catalog\` (
          \`session_id\` text PRIMARY KEY,
          \`catalog\` text NOT NULL,
          CONSTRAINT \`fk_session_skill_catalog_session_id_session_id_fk\` FOREIGN KEY (\`session_id\`) REFERENCES \`session\`(\`id\`) ON DELETE CASCADE
        );
      `)
    })
  },
} satisfies DatabaseMigration.Migration
