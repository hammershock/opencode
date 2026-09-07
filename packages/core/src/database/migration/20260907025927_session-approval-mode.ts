import { Effect } from "effect"
import type { DatabaseMigration } from "../migration"

export default {
  id: "20260907025927_session-approval-mode",
  up(tx) {
    return Effect.gen(function* () {
      yield* tx.run(`ALTER TABLE \`session\` ADD \`approval_mode\` text DEFAULT 'normal' NOT NULL;`)
    })
  },
} satisfies DatabaseMigration.Migration
