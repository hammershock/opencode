import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionSkillCatalog } from "@opencode-ai/core/session/skill-catalog"
import { SessionSkillCatalogTable, SessionTable } from "@opencode-ai/core/session/sql"
import { Skill } from "@opencode-ai/schema/skill"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(Database.node))
const sessionID = SessionSchema.ID.make("ses_skill_identity")
const digest = Skill.Digest.make("a".repeat(64))
const metadata = (id: string) =>
  Skill.Metadata.make({
    id: Skill.ID.make(`skl_${id.repeat(64)}`),
    name: "review",
    description: "Review",
    sourceLabel: "Imported",
    digest,
  })

describe("SessionSkillCatalog", () => {
  it.effect("retains colliding device-local identities and cascades with the Session", () =>
    Effect.gen(function* () {
      const { db } = yield* Database.Service
      yield* db
        .insert(ProjectTable)
        .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
        .run()
      yield* db
        .insert(SessionTable)
        .values({
          id: sessionID,
          project_id: ProjectV2.ID.global,
          slug: "skill-identity",
          directory: "/project",
          title: "skill identity",
          version: "test",
        })
        .run()

      const first = metadata("1")
      const second = metadata("2")
      const catalog = SessionSkillCatalog.make(digest, [second, first])
      yield* SessionSkillCatalog.replace(db, sessionID, { catalog, guidance: "Available skills" })

      expect((yield* SessionSkillCatalog.get(db, sessionID))?.skills.map((skill) => skill.id)).toEqual([
        first.id,
        second.id,
      ])
      expect(yield* SessionSkillCatalog.guidance(db, sessionID)).toBe("Available skills")
      expect(SessionSkillCatalog.admitted(catalog, first)).toBe(true)
      expect(SessionSkillCatalog.admitted(catalog, { ...first, id: Skill.ID.make(`skl_${"3".repeat(64)}`) })).toBe(
        false,
      )

      yield* db.delete(SessionTable).where(eq(SessionTable.id, sessionID)).run()
      expect(yield* db.select().from(SessionSkillCatalogTable).all()).toEqual([])
    }),
  )
})
