import { describe, expect } from "bun:test"
import { eq } from "drizzle-orm"
import { DateTime, Effect, Schema } from "effect"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionContextEpoch } from "@opencode-ai/core/session/context-epoch"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SystemContext } from "@opencode-ai/core/system-context"
import { testEffect } from "./lib/effect"

const it = testEffect(AppNodeBuilder.build(LayerNode.group([Database.node, EventV2.node, SessionProjector.node])))
const sessionID = SessionSchema.ID.make("ses_skill_context_activation")
const environment = SystemContext.make({
  key: SystemContext.Key.make("core/environment"),
  refresh: "generation",
  codec: Schema.toCodecJson(ModelContext.Environment),
  load: Effect.succeed(
    ModelContext.Environment.make({
      harness: "OpenCode Transit",
      entrypoint: "opencode-transit",
      targetKind: "local",
      targetName: "test",
      directory: "/project",
      projectRoot: "/project",
      platform: "test",
    }),
  ),
  baseline: () => "Environment baseline",
  update: () => "Environment update",
})

const legacyContext = (value: string) =>
  SystemContext.combine([
    environment,
    SystemContext.make({
      key: SystemContext.Key.make("core/skill-guidance"),
      refresh: "activation",
      codec: Schema.toCodecJson(Schema.String),
      load: Effect.succeed(value),
      baseline: (current) => `Skills: ${current}`,
      update: (_previous, current) => `Skills changed: ${current}`,
    }),
  ])

describe("SessionContextEpoch activation", () => {
  it.effect(
    "removes legacy Skill guidance from the local runtime projection without publishing a migration event",
    () =>
      Effect.gen(function* () {
        const { db } = yield* Database.Service
        const events = yield* EventV2.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
          .run()
        yield* db
          .insert(SessionTable)
          .values({
            id: sessionID,
            project_id: ProjectV2.ID.global,
            slug: "legacy-skill-context",
            directory: "/project",
            title: "legacy skill context",
            version: "test",
          })
          .run()
        const initial = yield* SystemContext.initialize(legacyContext("old"))
        yield* db
          .insert(SessionContextEpochTable)
          .values({
            session_id: sessionID,
            baseline: initial.baseline,
            snapshot: initial.snapshot,
            baseline_seq: 0,
            generation: 1,
            reason: "created",
            location_revision: 0,
            digest: SessionContextEpoch.digest(initial.snapshot),
          })
          .run()
        const changed = yield* SystemContext.initialize(legacyContext("new"))
        yield* events.publish(SessionEvent.ContextAdvanced, {
          sessionID,
          messageID: SessionMessage.ID.create(),
          timestamp: yield* DateTime.now,
          cause: "skill-catalog-reloaded",
          text: "Skills changed: new",
          sources: changed.snapshot,
          digest: SessionContextEpoch.digest(changed.snapshot),
        })
        const before = yield* db
          .select({ id: EventTable.id })
          .from(EventTable)
          .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.ContextAdvanced.type, 1)))
          .all()

        const current = Effect.succeed(SystemContext.combine([environment]))
        expect(yield* SessionContextEpoch.initialize(db, events, current, sessionID, 0)).toMatchObject({
          baseline: "Environment baseline",
        })
        expect(yield* SessionContextEpoch.forPrompt(db, events, current, sessionID, 0)).toMatchObject({
          baseline: "Environment baseline",
          advances: [],
        })
        expect(
          (yield* SessionContextEpoch.inspect(db, sessionID))?.sources[SystemContext.Key.make("core/skill-guidance")],
        ).toBeUndefined()
        expect(
          yield* db
            .select({ id: EventTable.id })
            .from(EventTable)
            .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.ContextAdvanced.type, 1)))
            .all(),
        ).toEqual(before)
      }),
  )
})
