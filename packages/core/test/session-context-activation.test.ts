import { describe, expect } from "bun:test"
import { asc, eq } from "drizzle-orm"
import { Deferred, Effect, Fiber, Schema } from "effect"
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
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionContextEpochTable, SessionMessageTable, SessionTable } from "@opencode-ai/core/session/sql"
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

const context = (value: string, hook = Effect.void) =>
  SystemContext.combine([
    environment,
    SystemContext.make({
      key: SystemContext.Key.make("core/skill-guidance"),
      refresh: "activation",
      codec: Schema.toCodecJson(Schema.String),
      load: hook.pipe(Effect.as(value)),
      baseline: (current) => `Skills: ${current}`,
      update: (_previous, current) => `Skills changed: ${current}`,
    }),
  ])

describe("SessionContextEpoch activation", () => {
  it.effect("initializes once and appends only changed activation context without replacing the generation", () =>
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
          slug: "skill-context",
          directory: "/project",
          title: "skill context",
          version: "test",
        })
        .run()

      const load = (value: string, hook = Effect.void) => Effect.succeed({ context: context(value, hook), value })
      expect(yield* SessionContextEpoch.activate(db, events, load("review"), sessionID, 0)).toEqual({
        status: "initialized",
        value: "review",
      })
      const initial = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
      expect(initial).toMatchObject({
        generation: 1,
        location_revision: 0,
        baseline: "Environment baseline\n\nSkills: review",
      })

      let ordinaryLoads = 0
      yield* SessionContextEpoch.prepare(
        db,
        events,
        Effect.succeed(
          context(
            "changed on disk",
            Effect.sync(() => ordinaryLoads++),
          ),
        ),
        sessionID,
        0,
      )
      expect(ordinaryLoads).toBe(0)
      expect(yield* SessionContextEpoch.activate(db, events, load("review"), sessionID, 0)).toMatchObject({
        status: "unchanged",
      })
      expect(yield* SessionContextEpoch.activate(db, events, load("review-v2"), sessionID, 0)).toMatchObject({
        status: "advanced",
      })

      const after = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, sessionID))
        .get()
      expect(after).toMatchObject({
        generation: 1,
        location_revision: 0,
        baseline: initial!.baseline,
        baseline_seq: initial!.baseline_seq,
      })
      const advances = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, EventV2.versionedType(SessionEvent.ContextAdvanced.type, 1)))
        .orderBy(asc(EventTable.seq))
        .all()
      expect(advances).toHaveLength(1)
      expect(advances[0]?.data).toMatchObject({ cause: "skill-catalog-reloaded", text: "Skills changed: review-v2" })
      expect(
        yield* db
          .select({ type: SessionMessageTable.type })
          .from(SessionMessageTable)
          .where(eq(SessionMessageTable.session_id, sessionID))
          .all(),
      ).toEqual([{ type: "system" }])
    }),
  )

  it.effect("serializes concurrent activation loads for the same Session", () =>
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
          slug: "skill-context",
          directory: "/project",
          title: "skill context",
          version: "test",
        })
        .run()
      yield* SessionContextEpoch.activate(
        db,
        events,
        Effect.succeed({ context: context("initial"), value: "initial" }),
        sessionID,
        0,
      )

      let active = 0
      let maximum = 0
      const entered = yield* Deferred.make<void>()
      const release = yield* Deferred.make<void>()
      const load = (value: string) =>
        Effect.acquireUseRelease(
          Effect.sync(() => {
            active++
            maximum = Math.max(maximum, active)
          }),
          () =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ context: context(value), value }),
            ),
          () => Effect.sync(() => active--),
        )
      const first = yield* SessionContextEpoch.activate(db, events, load("first"), sessionID, 0).pipe(
        Effect.forkChild,
      )
      const second = yield* SessionContextEpoch.activate(db, events, load("second"), sessionID, 0).pipe(
        Effect.forkChild,
      )

      yield* Deferred.await(entered)
      expect(maximum).toBe(1)
      yield* Deferred.succeed(release, undefined)
      const results = yield* Effect.all([Fiber.join(first), Fiber.join(second)], { concurrency: "unbounded" })
      expect(results.map((result) => result.status)).toEqual(["advanced", "advanced"])
    }),
  )
})
