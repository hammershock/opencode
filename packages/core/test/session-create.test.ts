import { describe, expect } from "bun:test"
import path from "path"
import { chmod, mkdir } from "node:fs/promises"
import { Effect, Layer, Stream } from "effect"
import { AgentV2 } from "@opencode-ai/core/agent"
import { asc, eq } from "drizzle-orm"
import { Database } from "@opencode-ai/core/database/database"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Location } from "@opencode-ai/core/location"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProjectV2 } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Prompt } from "@opencode-ai/core/session/prompt"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { SessionExecution } from "@opencode-ai/core/session/execution"
import { SessionInput } from "@opencode-ai/core/session/input"
import { SessionEvent } from "@opencode-ai/core/session/event"
import { SessionLocationRuntime } from "@opencode-ai/core/session/location-runtime"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionStore } from "@opencode-ai/core/session/store"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { WorkspaceV2 } from "@opencode-ai/core/workspace"
import { testEffect } from "./lib/effect"
import { tmpdir } from "./fixture/tmpdir"

const projects = Layer.succeed(
  ProjectV2.Service,
  ProjectV2.Service.of({
    resolve: (directory) => Effect.succeed({ id: ProjectV2.ID.global, directory }),
    directories: () => Effect.succeed([]),
    commit: () => Effect.void,
  }),
)
const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      Database.node,
      EventV2.node,
      SessionProjector.node,
      SessionStore.node,
      SessionLocationRuntime.node,
      SessionV2.node,
    ]),
    [
      [ProjectV2.node, projects],
      [SessionExecution.node, SessionExecution.noopLayer],
    ],
  ),
)
const location = Location.Ref.make({ directory: AbsolutePath.make("/project") })
const id = SessionV2.ID.create()

describe("SessionV2.create", () => {
  it.effect("guards direct Core mutators when the Session Location is unresolved", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({
          target: { type: "rexd", targetID: Location.TargetID.make("11111111-1111-4111-8111-111111111111") },
          directory: AbsolutePath.make("/historical/worktree"),
        }),
      })
      const unavailable = (effect: Effect.Effect<unknown, unknown>) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error as { _tag?: string })._tag),
        )

      expect(yield* unavailable(session.switchAgent({ sessionID: created.id, agent: "plan" }))).toBe(
        "Session.OperationUnavailableError",
      )
      expect(
        yield* unavailable(
          session.switchModel({
            sessionID: created.id,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          }),
        ),
      ).toBe("Session.OperationUnavailableError")
      expect(
        yield* unavailable(
          session.revert.stage({
            sessionID: created.id,
            messageID: SessionMessage.ID.make("msg_unresolved_revert"),
            files: false,
          }),
        ),
      ).toBe("Session.OperationUnavailableError")
    }),
  )

  it.effect("rebinds an unresolved Session without materializing its old Location", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const locationRuntime = yield* SessionLocationRuntime.Service
      const reset: string[] = []
      yield* locationRuntime.register((sessionID) => Effect.sync(() => reset.push(sessionID)))
      const created = yield* session.create({
        location: Location.Ref.make({
          target: { type: "rexd", targetID: Location.TargetID.make("22222222-2222-4222-8222-222222222222") },
          directory: AbsolutePath.make("/historical/worktree"),
        }),
      })
      const destination = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })

      expect(
        yield* session.rebindLocation({
          sessionID: created.id,
          expectedRevision: created.locationRevision,
          destination,
        }),
      ).toMatchObject({ status: "rebound", revision: created.locationRevision + 1 })
      expect((yield* session.get(created.id)).location).toEqual(destination)
      expect(reset).toEqual([created.id])
      const { db } = yield* Database.Service
      expect(
        yield* db
          .select()
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, created.id))
          .get(),
      ).toMatchObject({
        session_id: created.id,
        generation: 1,
        reason: "location-rebound",
        location_revision: created.locationRevision + 1,
      })
      const rebound = yield* db
        .select({ data: EventTable.data })
        .from(EventTable)
        .where(eq(EventTable.type, "session.next.location.rebound.1"))
        .get()
      expect(rebound?.data).toMatchObject({
        context: { reason: "location-rebound", locationRevision: created.locationRevision + 1 },
      })
    }),
  )

  it.effect("rejects missing and non-directory local rebind destinations before commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({
          target: { type: "rexd", targetID: Location.TargetID.make("33333333-3333-4333-8333-333333333333") },
          directory: AbsolutePath.make("/historical/worktree"),
        }),
      })
      const destinations = [path.join(tmp.path, "missing"), path.join(tmp.path, "file")]
      yield* Effect.promise(() => Bun.write(destinations[1], "not a directory"))

      for (const destination of destinations) {
        const error = yield* session
          .rebindLocation({
            sessionID: created.id,
            expectedRevision: created.locationRevision,
            destination: Location.Ref.make({ directory: AbsolutePath.make(destination) }),
          })
          .pipe(Effect.flip)
        expect(error).toBeInstanceOf(SessionV2.LocationRebindError)
        expect((yield* session.get(created.id)).locationRevision).toBe(created.locationRevision)
      }
    }),
  )

  it.effect("rejects an inaccessible local rebind destination before commit", () =>
    Effect.gen(function* () {
      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const locked = path.join(tmp.path, "locked")
      yield* Effect.promise(() => mkdir(locked))
      yield* Effect.acquireRelease(
        Effect.promise(() => chmod(locked, 0)),
        () => Effect.promise(() => chmod(locked, 0o700)),
      )
      const session = yield* SessionV2.Service
      const created = yield* session.create({
        location: Location.Ref.make({
          target: { type: "rexd", targetID: Location.TargetID.make("44444444-4444-4444-8444-444444444444") },
          directory: AbsolutePath.make("/historical/worktree"),
        }),
      })
      const error = yield* session
        .rebindLocation({
          sessionID: created.id,
          expectedRevision: created.locationRevision,
          destination: Location.Ref.make({ directory: AbsolutePath.make(locked) }),
        })
        .pipe(Effect.flip)

      expect(error).toBeInstanceOf(SessionV2.LocationRebindError)
      expect((yield* session.get(created.id)).locationRevision).toBe(created.locationRevision)
    }),
  )

  it.effect("creates a fresh projected session when the ID is omitted", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service

      const first = yield* session.create({ location })
      const second = yield* session.create({ location })

      expect(second.id).not.toBe(first.id)
      expect(yield* session.list()).toHaveLength(2)
    }),
  )

  it.effect("returns the original session when the ID is retried", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const first = yield* session.create(input)
      const retried = yield* session.create(input)

      expect(retried).toEqual(first)
      expect(yield* session.list()).toEqual([first])
    }),
  )

  it.effect("stores supplied immutable create attributes", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const workspaceID = WorkspaceV2.ID.make("wrk_test")
      const target = Location.RexdTarget.make({
        type: "rexd",
        targetID: Location.TargetID.make("013ea0a8-4523-4d39-a609-552222340b19"),
      })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("fast"),
      })

      expect(
        yield* session.create({
          location: Location.Ref.make({
            target,
            directory: location.directory,
            workspaceID,
            lastKnownTargetName: "gpu",
          }),
          agent: AgentV2.ID.make("build"),
          model,
          approvalMode: "auto",
        }),
      ).toMatchObject({
        location: { target, directory: location.directory, workspaceID, lastKnownTargetName: "gpu" },
        agent: "build",
        model,
        approvalMode: "auto",
      })
    }),
  )

  it.effect("returns the existing Session when one ID is reused with different create arguments", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ id, location })
      const changed = [
        { id, location: Location.Ref.make({ directory: AbsolutePath.make("/other") }) },
        { id, location, agent: AgentV2.ID.make("build") },
        {
          id,
          location,
          model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
        },
      ]

      for (const input of changed) {
        expect(yield* session.create(input)).toEqual(created)
      }
      expect(yield* session.list()).toHaveLength(1)
    }),
  )

  it.effect("returns one recorded session to concurrent exact retries", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const input = { id, location }

      const created = yield* Effect.all([session.create(input), session.create(input)], { concurrency: "unbounded" })

      expect(created[1]).toEqual(created[0])
      expect(yield* session.list()).toEqual([created[0]])
    }),
  )

  it.effect("returns the current Session projection after updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const input = { id, location }
      const created = yield* session.create(input)

      yield* db.update(SessionTable).set({ agent: "build" }).where(eq(SessionTable.id, id)).run().pipe(Effect.orDie)

      expect(yield* session.create(input)).toMatchObject({ id: created.id, agent: "build" })
    }),
  )

  it.effect("returns the current Session projection after projected updates", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const remote = Location.Ref.make({
        target: Location.RexdTarget.make({
          type: "rexd",
          targetID: Location.TargetID.make("013ea0a8-4523-4d39-a609-552222340b19"),
        }),
        directory: location.directory,
        lastKnownTargetName: "gpu",
      })
      const input = { id, location: remote }
      const created = yield* session.create(input)

      yield* events.publish(SessionV1.Event.Updated, {
        sessionID: id,
        info: SessionV1.SessionInfo.make({
          id,
          slug: "updated",
          version: "test",
          projectID: created.projectID,
          directory: created.location.directory,
          title: "updated",
          agent: "build",
          time: { created: 0, updated: 1 },
        }),
      })

      expect(yield* session.create(input)).toMatchObject({ id, agent: "build", location: remote })
    }),
  )

  it.effect("persists creation through the existing legacy created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toMatchObject([{ type: EventV2.versionedType(SessionV1.Event.Created.type, 1) }])
    }),
  )

  it.effect("persists caller-ID creation through the existing created event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const created = yield* session.create({ id, location })

      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).get().pipe(Effect.orDie),
      ).toMatchObject({
        data: { sessionID: id },
      })
    }),
  )

  it.effect("establishes canonical context before admitting the first V2 prompt", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const events = yield* EventV2.Service
      const { db } = yield* Database.Service
      const promptLocation = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
      const created = yield* session.create({ location: promptLocation })
      yield* session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Hello" }), resume: false })
      yield* SessionInput.promoteSteers(db, events, created.id, Number.MAX_SAFE_INTEGER)

      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(3), Stream.runCollect)),
      ).toMatchObject([
        {
          durable: { seq: 1 },
          type: "session.next.context.generation.established",
          data: { context: { reason: "created", generation: 1 } },
        },
        { durable: { seq: 2 }, type: "session.next.prompt.admitted", data: { prompt: { text: "Hello" } } },
        { durable: { seq: 3 }, type: "session.next.prompted" },
      ])
    }),
  )

  it.effect("establishes only one context generation for concurrent first prompts", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const { db } = yield* Database.Service
      const promptLocation = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
      const created = yield* session.create({ location: promptLocation })

      yield* Effect.all(
        [
          session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "First" }), resume: false }),
          session.prompt({ sessionID: created.id, prompt: Prompt.make({ text: "Second" }), resume: false }),
        ],
        { concurrency: "unbounded" },
      )

      const events = yield* db
        .select({ type: EventTable.type })
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .all()
      expect(
        events.filter(
          (event) => event.type === EventV2.versionedType(SessionEvent.ContextGenerationEstablished.type, 1),
        ),
      ).toHaveLength(1)
    }),
  )

  it.effect("replays one prompt lifecycle into a fresh target database", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const sourceEvents = yield* EventV2.Service
      const sourceDb = (yield* Database.Service).db
      const promptLocation = Location.Ref.make({ directory: AbsolutePath.make(process.cwd()) })
      const created = yield* session.create({
        id: SessionV2.ID.make("ses_fresh_target_replay"),
        location: promptLocation,
      })
      const admitted = yield* session.prompt({
        sessionID: created.id,
        prompt: Prompt.make({ text: "Replay lifecycle" }),
        resume: false,
      })
      yield* SessionInput.promoteSteers(sourceDb, sourceEvents, created.id, Number.MAX_SAFE_INTEGER)
      const serialized = (yield* sourceDb
        .select()
        .from(EventTable)
        .where(eq(EventTable.aggregate_id, created.id))
        .orderBy(asc(EventTable.seq))
        .all()
        .pipe(Effect.orDie)).map((event) => ({
        id: event.id,
        aggregateID: event.aggregate_id,
        seq: event.seq,
        type: event.type,
        data: event.data,
      }))

      const tmp = yield* Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      )
      const targetDatabase = Database.layerFromPath(path.join(tmp.path, "target.sqlite"))
      const targetLayer = AppNodeBuilder.build(
        LayerNode.group([Database.node, EventV2.node, SessionProjector.node, SessionStore.node]),
        [[Database.node, targetDatabase]],
      )

      yield* Effect.gen(function* () {
        const db = (yield* Database.Service).db
        const events = yield* EventV2.Service
        const store = yield* SessionStore.Service
        yield* db
          .insert(ProjectTable)
          .values({ id: ProjectV2.ID.global, worktree: promptLocation.directory, sandboxes: [] })
          .run()
          .pipe(Effect.orDie)

        expect(yield* store.get(created.id)).toBeUndefined()
        expect(yield* events.replayAll(serialized.slice(0, 3))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 2,
        })
        expect(yield* store.context(created.id)).toEqual([])

        expect(yield* events.replayAll(serialized.slice(3))).toBe(created.id)
        expect(yield* SessionInput.find(db, admitted.id)).toMatchObject({
          id: admitted.id,
          sessionID: created.id,
          prompt: { text: "Replay lifecycle" },
          delivery: "steer",
          admittedSeq: 2,
          promotedSeq: 3,
        })
        expect(yield* store.context(created.id)).toMatchObject([
          { id: admitted.id, type: "user", text: "Replay lifecycle" },
        ])
        expect(
          (yield* db
            .select()
            .from(EventTable)
            .where(eq(EventTable.aggregate_id, created.id))
            .orderBy(asc(EventTable.seq))
            .all()
            .pipe(Effect.orDie)).map((event) => [event.seq, event.type]),
        ).toEqual([
          [0, EventV2.versionedType(SessionV1.Event.Created.type, 1)],
          [1, EventV2.versionedType(SessionEvent.ContextGenerationEstablished.type, 1)],
          [2, EventV2.versionedType(SessionEvent.PromptAdmitted.type, 1)],
          [3, EventV2.versionedType(SessionEvent.Prompted.type, 1)],
        ])
      }).pipe(Effect.provide(Layer.fresh(targetLayer)))
    }),
  )

  it.effect("does not mask unrelated created projector defects", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const event = yield* EventV2.Service
      const defect = new Error("unrelated projector defect")
      yield* event.project(SessionV1.Event.Created, () => Effect.die(defect))

      expect(yield* session.create({ id, location }).pipe(Effect.catchDefect(Effect.succeed))).toBe(defect)
    }),
  )

  it.effect("reports unfinished Session operations as unavailable", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const unavailable = (
        effect: Effect.Effect<void, SessionV2.NotFoundError | SessionV2.OperationUnavailableError>,
      ) =>
        effect.pipe(
          Effect.flip,
          Effect.map((error) => (error instanceof SessionV2.OperationUnavailableError ? error.operation : "not-found")),
        )

      expect(yield* unavailable(session.shell({ sessionID: created.id, command: "pwd" }))).toBe("shell")
      expect(yield* unavailable(session.skill({ sessionID: created.id, skill: "review" }))).toBe("skill")
    }),
  )

  it.effect("switches the selected agent through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })

      yield* session.switchAgent({ sessionID: created.id, agent: "plan" })

      expect(yield* session.get(created.id)).toMatchObject({ agent: "plan" })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.agent.switched", data: { agent: "plan" } }])
    }),
  )

  it.effect("rejects an agent switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_agent_switch")

      expect(
        yield* session.switchAgent({ sessionID: missing, agent: "plan" }).pipe(
          Effect.flip,
          Effect.map((error) => error._tag),
        ),
      ).toBe("Session.NotFoundError")
    }),
  )

  it.effect("switches the selected model through the durable Session event", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({
        id: ModelV2.ID.make("sonnet"),
        providerID: ProviderV2.ID.anthropic,
        variant: ModelV2.VariantID.make("high"),
      })

      yield* session.switchModel({ sessionID: created.id, model })

      expect(yield* session.get(created.id)).toMatchObject({ model })
      expect(
        Array.from(yield* session.events({ sessionID: created.id }).pipe(Stream.take(1), Stream.runCollect)),
      ).toMatchObject([{ type: "session.next.model.switched", data: { model } }])
    }),
  )

  it.effect("ignores a model switch when the selected model is unchanged", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const created = yield* session.create({ location })
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })

      yield* session.switchModel({ sessionID: created.id, model })
      yield* session.switchModel({ sessionID: created.id, model })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(2)
      expect(yield* session.get(created.id)).toMatchObject({ model })
    }),
  )

  it.effect("treats an omitted variant as the default variant", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const model = ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic })
      const created = yield* session.create({ location, model })

      yield* session.switchModel({
        sessionID: created.id,
        model: ModelV2.Ref.make({ ...model, variant: ModelV2.VariantID.make("default") }),
      })

      const { db } = yield* Database.Service
      expect(
        yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, created.id)).all().pipe(Effect.orDie),
      ).toHaveLength(1)
    }),
  )

  it.effect("rejects a model switch for a missing Session", () =>
    Effect.gen(function* () {
      const session = yield* SessionV2.Service
      const missing = SessionV2.ID.make("ses_missing_model_switch")

      expect(
        yield* session
          .switchModel({
            sessionID: missing,
            model: ModelV2.Ref.make({ id: ModelV2.ID.make("sonnet"), providerID: ProviderV2.ID.anthropic }),
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error._tag),
          ),
      ).toBe("Session.NotFoundError")
    }),
  )
})
