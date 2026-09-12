export * as SessionSkillCatalog from "./skill-catalog"

import { eq } from "drizzle-orm"
import { Effect, Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import type { Database } from "../database/database"
import { Hash } from "../util/hash"
import { SessionSchema } from "./schema"
import { SessionSkillCatalogTable } from "./sql"

type DatabaseService = Database.Interface["db"]

export interface View {
  readonly catalog: Skill.AdmittedCatalog
  readonly guidance?: string
}

export function make(revision: Skill.Digest, metadata: ReadonlyArray<Skill.Metadata>) {
  const skills = metadata
    .map((skill) =>
      Skill.AdmittedIdentity.make({
        id: skill.id,
        name: skill.name,
        sourceLabel: skill.sourceLabel,
        digest: skill.digest,
      }),
    )
    .toSorted(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.sourceLabel.localeCompare(b.sourceLabel) ||
        a.digest.localeCompare(b.digest) ||
        a.id.localeCompare(b.id),
    )
  return Skill.AdmittedCatalog.make({
    revision,
    skills,
    digest: Skill.Digest.make(Hash.sha256(JSON.stringify(skills))),
  })
}

export const replace = Effect.fn("SessionSkillCatalog.replace")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  view: { readonly catalog: Skill.AdmittedCatalog; readonly guidance: string },
) {
  yield* db
    .insert(SessionSkillCatalogTable)
    .values({ session_id: sessionID, catalog: view.catalog, guidance: view.guidance })
    .onConflictDoUpdate({
      target: SessionSkillCatalogTable.session_id,
      set: { catalog: view.catalog, guidance: view.guidance },
    })
    .run()
    .pipe(Effect.orDie)
})

export const view = Effect.fn("SessionSkillCatalog.view")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const row = yield* db
    .select({ catalog: SessionSkillCatalogTable.catalog, guidance: SessionSkillCatalogTable.guidance })
    .from(SessionSkillCatalogTable)
    .where(eq(SessionSkillCatalogTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
  if (!row) return undefined
  const catalog = Schema.decodeUnknownOption(Skill.AdmittedCatalog)(row.catalog).valueOrUndefined
  if (!catalog) return undefined
  return { catalog, ...(row.guidance === null ? {} : { guidance: row.guidance }) } satisfies View
})

export const get = Effect.fn("SessionSkillCatalog.get")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return (yield* view(db, sessionID))?.catalog
})

export const guidance = Effect.fn("SessionSkillCatalog.guidance")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return (yield* view(db, sessionID))?.guidance
})

export function admitted(catalog: Skill.AdmittedCatalog | undefined, metadata: Skill.Metadata) {
  return catalog?.skills.some(
    (skill) =>
      skill.id === metadata.id &&
      skill.name === metadata.name &&
      skill.sourceLabel === metadata.sourceLabel &&
      skill.digest === metadata.digest,
  )
}
