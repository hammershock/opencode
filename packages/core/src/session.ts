export * as SessionV2 from "./session"
export * from "./session/schema"

import { Cause, DateTime, Effect, Exit, Layer, Schema, Context, Stream } from "effect"
import { ListAnchor } from "@opencode-ai/schema/session"
import { and, asc, desc, eq, gt, like, lt, or, type SQL } from "drizzle-orm"
import { ProjectV2 } from "./project"
import { WorkspaceV2 } from "./workspace"
import { ModelV2 } from "./model"
import { Location } from "./location"
import { SessionMessage } from "./session/message"
import { Prompt } from "./session/prompt"
import { PromptInput } from "@opencode-ai/schema/prompt-input"
import { EventV2 } from "./event"
import { Database } from "./database/database"
import { SessionProjector } from "./session/projector"
import { SessionContextEpochTable, SessionMessageTable, SessionTable } from "./session/sql"
import { SessionSchema } from "./session/schema"
import { AbsolutePath, PositiveInt, RelativePath } from "./schema"
import { AgentV2 } from "./agent"
import { SessionV1 } from "./v1/session"
import { InstallationVersion } from "./installation/version"
import { Slug } from "./util/slug"
import { ProjectTable } from "./project/sql"
import path from "path"
import { fromRow } from "./session/info"
import { SessionRunner } from "./session/runner/index"
import { SessionStore } from "./session/store"
import { SessionExecution } from "./session/execution"
import { makeGlobalNode } from "./effect/app-node"
import { LocationServiceMap } from "./location-service-map"
import { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"
import { SessionEvent } from "./session/event"
import { SessionInput } from "./session/input"
import { SessionTurn } from "./session/turn"
import { Snapshot } from "./snapshot"
import { SessionRevert } from "./session/revert"
import { Revert } from "@opencode-ai/schema/revert"
import { FSUtil } from "./fs-util"
import { SessionDurable } from "@opencode-ai/schema/durable-event-manifest"
import { Pty } from "./pty"
import { PermissionV2 } from "./permission"
import { QuestionV2 } from "./question"
import { SessionActivity } from "./session/activity"
import { SessionLocationAccess } from "./session/location-access"
import { SessionLocationMutation } from "./session/location-mutation"
import { SyncSetup } from "./sync/setup"
import type { ApprovalMode } from "@opencode-ai/schema/approval-mode"
import type { ModelContext } from "@opencode-ai/schema/model-context"
import { FileSystem } from "./filesystem"
import { SessionLocationRuntime } from "./session/location-runtime"
import { SystemContext } from "./system-context/index"
import { SessionContextEpoch } from "./session/context-epoch"
import { ModelContextAssembler } from "./model-context-assembler"
import { SkillCatalogContextService } from "./skill/catalog-context-service"
import { Skill } from "@opencode-ai/schema/skill"

export const RevertState = Revert.State
export type RevertState = Revert.State

// get project -> project.locations
//
// get all sessions
//

// - by project
//   - by subpath
// - by workspace (home is special)

export { ListAnchor }

const ListInputBase = {
  workspaceID: WorkspaceV2.ID.pipe(Schema.optional),
  search: Schema.String.pipe(Schema.optional),
  limit: PositiveInt.pipe(Schema.optional),
  order: Schema.Literals(["asc", "desc"]).pipe(Schema.optional),
  anchor: ListAnchor.pipe(Schema.optional),
}

const ListDirectoryInput = Schema.Struct({
  ...ListInputBase,
  directory: AbsolutePath,
})

const ListProjectInput = Schema.Struct({
  ...ListInputBase,
  project: ProjectV2.ID,
  subpath: RelativePath.pipe(Schema.optional),
})

const ListAllInput = Schema.Struct(ListInputBase)

export const ListInput = Schema.Union([ListDirectoryInput, ListProjectInput, ListAllInput])
export type ListInput = typeof ListInput.Type

type CreateInput = {
  id?: SessionSchema.ID
  agent?: AgentV2.ID
  model?: ModelV2.Ref
  location: Location.Ref
  approvalMode?: ApprovalMode.Mode
}

type CompactInput = {
  sessionID: SessionSchema.ID
  prompt?: Prompt
}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("Session.NotFoundError", {
  sessionID: SessionSchema.ID,
}) {}

export class OperationUnavailableError extends Schema.TaggedErrorClass<OperationUnavailableError>()(
  "Session.OperationUnavailableError",
  {
    operation: Schema.Literals([
      "move",
      "shell",
      "skill",
      "switchAgent",
      "compact",
      "wait",
      "location",
      "modelContext",
    ]),
  },
) {}

export { ContextSnapshotDecodeError, MessageDecodeError } from "./session/error"

export class PromptConflictError extends Schema.TaggedErrorClass<PromptConflictError>()("Session.PromptConflictError", {
  sessionID: SessionSchema.ID,
  messageID: SessionMessage.ID,
}) {}
export class LocationRebindError extends Schema.TaggedErrorClass<LocationRebindError>()("Session.LocationRebindError", {
  message: Schema.String,
}) {}
export const MessageNotFoundError = SessionRevert.MessageNotFoundError
export type MessageNotFoundError = SessionRevert.MessageNotFoundError

export type Error = NotFoundError | MessageDecodeError | OperationUnavailableError | PromptConflictError

export interface Interface {
  readonly list: (input?: ListInput) => Effect.Effect<SessionSchema.Info[]>
  readonly create: (input: CreateInput) => Effect.Effect<SessionSchema.Info>
  readonly get: (sessionID: SessionSchema.ID) => Effect.Effect<SessionSchema.Info, NotFoundError>
  readonly messages: (input: {
    sessionID: SessionSchema.ID
    limit?: number
    order?: "asc" | "desc"
    cursor?: {
      id: SessionMessage.ID
      direction: "previous" | "next"
    }
  }) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  readonly message: (input: {
    sessionID: SessionSchema.ID
    messageID: SessionMessage.ID
  }) => Effect.Effect<SessionMessage.Message | undefined>
  readonly context: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<SessionMessage.Message[], NotFoundError | MessageDecodeError>
  /** Inspect the frozen durable model context without resolving the Session Location. */
  readonly modelContext: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<ModelContext.Generation | undefined, NotFoundError | ContextSnapshotDecodeError>
  readonly events: (input: {
    sessionID: SessionSchema.ID
    after?: number
  }) => Stream.Stream<SessionEvent.DurableEvent, NotFoundError>
  readonly history: (input: {
    sessionID: SessionSchema.ID
    after?: number
    limit: number
  }) => Effect.Effect<{ events: ReadonlyArray<SessionEvent.DurableEvent>; hasMore: boolean }, NotFoundError>
  readonly switchAgent: (input: {
    sessionID: SessionSchema.ID
    agent: string
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly switchModel: (input: {
    sessionID: SessionSchema.ID
    model: ModelV2.Ref
  }) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly prompt: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
    delivery?: SessionInput.Delivery
    resume?: boolean
  }) => Effect.Effect<SessionInput.Admitted, NotFoundError | PromptConflictError | OperationUnavailableError>
  /** Admits one queued prompt and resolves only from that exact input's durable terminal settlement. */
  readonly promptTurn: (input: {
    id?: SessionMessage.ID
    sessionID: SessionSchema.ID
    prompt: PromptInput.Prompt
  }) => Effect.Effect<
    SessionTurn.Outcome,
    NotFoundError | PromptConflictError | OperationUnavailableError | SessionRunner.RunError
  >
  readonly shell: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    command: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly skill: (input: {
    id?: EventV2.ID
    sessionID: SessionSchema.ID
    skill: string
    resume?: boolean
  }) => Effect.Effect<void, OperationUnavailableError>
  readonly compact: (input: CompactInput) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly wait: (id: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  readonly active: Effect.Effect<ReadonlySet<SessionSchema.ID>>
  readonly activate: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<Skill.Activation, NotFoundError | OperationUnavailableError>
  readonly locationBlockers: (sessionID: SessionSchema.ID) => Effect.Effect<ReadonlyArray<string>, NotFoundError>
  readonly resume: (
    sessionID: SessionSchema.ID,
  ) => Effect.Effect<void, NotFoundError | OperationUnavailableError | SessionRunner.RunError>
  readonly interrupt: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  readonly rebindLocation: (input: {
    readonly sessionID: SessionSchema.ID
    readonly expectedRevision: number
    readonly destination: Location.Ref
  }) => Effect.Effect<
    { readonly status: "unchanged" | "rebound"; readonly revision: number; readonly warnings: readonly string[] },
    NotFoundError | LocationRebindError
  >
  readonly revert: {
    readonly stage: (input: {
      sessionID: SessionSchema.ID
      messageID: SessionMessage.ID
      files?: boolean
    }) => Effect.Effect<Revert.State, NotFoundError | MessageNotFoundError | Snapshot.Error | OperationUnavailableError>
    readonly clear: (
      sessionID: SessionSchema.ID,
    ) => Effect.Effect<void, NotFoundError | Snapshot.Error | OperationUnavailableError>
    readonly commit: (sessionID: SessionSchema.ID) => Effect.Effect<void, NotFoundError | OperationUnavailableError>
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/Session") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const database = yield* Database.Service
    const db = database.db
    const events = yield* EventV2.Service
    const projects = yield* ProjectV2.Service
    const execution = yield* SessionExecution.Service
    const store = yield* SessionStore.Service
    const locations = yield* LocationServiceMap.Service
    const decodeMessage = Schema.decodeUnknownEffect(SessionMessage.Message)
    const locationMutation = yield* SessionLocationMutation.Service
    const locationRuntime = yield* SessionLocationRuntime.Service
    const activity = yield* SessionActivity.Service
    const locationAccess = yield* SessionLocationAccess.Service
    const requireLocation = Effect.fn("V2Session.requireLocation")(function* (sessionID: SessionSchema.ID) {
      return yield* locationAccess.require(sessionID).pipe(
        Effect.catchTag("SessionLocationAccess.NotFoundError", () => new NotFoundError({ sessionID })),
        Effect.catchTag(
          "SessionLocationAccess.UnresolvedError",
          () => new OperationUnavailableError({ operation: "location" }),
        ),
      )
    })
    const syncSetup = yield* SyncSetup.Service
    const contextInitialized = Effect.fn("V2Session.contextInitialized")(function* (sessionID: SessionSchema.ID) {
      return (
        (yield* db
          .select({ sessionID: SessionContextEpochTable.session_id })
          .from(SessionContextEpochTable)
          .where(eq(SessionContextEpochTable.session_id, sessionID))
          .get()
          .pipe(Effect.orDie)) !== undefined
      )
    })
    const activateCatalog = Effect.fn("V2Session.activateCatalog")(function* (
      session: SessionSchema.Info,
      location: Location.Ref,
      forceReload: boolean,
    ) {
      const initialized = yield* contextInitialized(session.id)
      const load = Effect.gen(function* () {
        const catalog = yield* SkillCatalogContextService.Service
        const loaded = yield* catalog.load({ forceReload })
        const assembler = yield* ModelContextAssembler.Service
        const context = yield* assembler.load(session.agent, {
          skillCatalog: loaded.snapshot,
          preserveSkillCatalog: forceReload && loaded.transient && initialized,
        })
        return { context, value: loaded }
      }).pipe(Effect.provide(locations.get(location)))
      const attempt = yield* SessionContextEpoch.activate(db, events, load, session.id, session.locationRevision).pipe(
        Effect.exit,
      )
      if (Exit.isFailure(attempt)) {
        yield* Effect.logWarning("Skill catalog activation failed", { sessionID: session.id })
        return Skill.Activation.make({
          status: initialized ? "retained" : "unavailable",
          diagnostics: [
            Skill.ActivationDiagnostic.make({
              kind: "reload-failed",
              severity: "warning",
              sourceLabel: "Skill catalog",
            }),
          ],
        })
      }
      const loaded = attempt.value.value
      return Skill.Activation.make({
        status: loaded.transient && initialized ? "retained" : attempt.value.status,
        diagnostics: loaded.diagnostics,
      })
    })
    const ensureContextForAdmission = Effect.fn("V2Session.ensureContextForAdmission")(function* (
      session: SessionSchema.Info,
      location: Location.Ref,
    ) {
      const unavailable = () => new OperationUnavailableError({ operation: "modelContext" })
      if (!(yield* contextInitialized(session.id))) {
        const activation = yield* activateCatalog(session, location, true)
        if (activation.status === "unavailable") return yield* unavailable()
        return
      }
      const assembler = yield* ModelContextAssembler.Service.pipe(Effect.provide(locations.get(location)))
      yield* SessionContextEpoch.prepare(
        db,
        events,
        assembler.load(session.agent),
        session.id,
        session.locationRevision,
      ).pipe(Effect.catch(unavailable))
    })
    const runtimeBlockers = Effect.fn("V2Session.runtimeLocationBlockers")(function* (sessionID: SessionSchema.ID) {
      if (!(yield* store.get(sessionID))) return yield* new NotFoundError({ sessionID })
      const blockers: string[] = []
      if ((yield* execution.active).has(sessionID)) blockers.push("agent_turn")
      if (
        (yield* SessionInput.hasPending(db, sessionID, "steer")) ||
        (yield* SessionInput.hasPending(db, sessionID, "queue"))
      )
        blockers.push("queued_turn")
      blockers.push(...(yield* activity.blockers(sessionID)))
      return blockers
    })
    const locationScopedBlockers = (sessionID: SessionSchema.ID, ref: Location.Ref) =>
      Effect.scoped(
        Effect.gen(function* () {
          const context = yield* locations.contextEffect(ref)
          const pty = Context.get(context, Pty.Service)
          const permissions = Context.get(context, PermissionV2.Service)
          const questions = Context.get(context, QuestionV2.Service)
          const blockers: string[] = []
          if ((yield* pty.list()).some((item) => item.status === "running")) blockers.push("terminal_pty")
          if ((yield* permissions.forSession(sessionID)).length) blockers.push("permission")
          if ((yield* questions.list()).some((item) => item.sessionID === sessionID)) blockers.push("question")
          return blockers
        }),
      )
    const locationBlockers = Effect.fn("V2Session.locationBlockers")(function* (sessionID: SessionSchema.ID) {
      const runtime = [...(yield* runtimeBlockers(sessionID))]
      const resolution = yield* locationAccess.resolve(sessionID).pipe(
        Effect.catchTag("SessionLocationAccess.NotFoundError", () => new NotFoundError({ sessionID })),
        Effect.catchTag("SessionLocationAccess.UnresolvedError", () =>
          Effect.succeed({ status: "resolution_failed" as const, message: "Session Location resolution failed" }),
        ),
      )
      if (resolution.status !== "resolved") return runtime
      return [...runtime, ...(yield* locationScopedBlockers(sessionID, resolution.location))]
    })
    const isDurableSessionEvent = Schema.is(SessionEvent.Durable)
    const decode = (row: typeof SessionMessageTable.$inferSelect) =>
      decodeMessage({ ...row.data, id: row.id, type: row.type }).pipe(
        Effect.mapError(
          () =>
            new MessageDecodeError({
              sessionID: SessionSchema.ID.make(row.session_id),
              messageID: SessionMessage.ID.make(row.id),
            }),
        ),
      )

    const prompt = Effect.fn("V2Session.prompt")(
      (input: {
        id?: SessionMessage.ID
        sessionID: SessionSchema.ID
        prompt: PromptInput.Prompt
        delivery?: SessionInput.Delivery
        resume?: boolean
      }) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.uninterruptible(
            Effect.gen(function* () {
              const location = yield* requireLocation(input.sessionID)
              const session = yield* result.get(input.sessionID)
              yield* ensureContextForAdmission(session, location)
              const resolved = resolvePrompt(input.prompt)
              const messageID = input.id ?? SessionMessage.ID.create()
              const delivery = input.delivery ?? "steer"
              const expected = { sessionID: input.sessionID, messageID, prompt: resolved, delivery }
              const admitted = yield* SessionInput.admit(db, events, {
                id: messageID,
                sessionID: input.sessionID,
                prompt: resolved,
                delivery,
              }).pipe(
                Effect.catchDefect((defect) =>
                  defect instanceof SessionInput.LifecycleConflict
                    ? new PromptConflictError({ sessionID: input.sessionID, messageID })
                    : Effect.die(defect),
                ),
              )
              if (!SessionInput.equivalent(admitted, expected))
                return yield* new PromptConflictError({ sessionID: input.sessionID, messageID })
              if (input.resume !== false) yield* execution.wake(admitted.sessionID)
              return admitted
            }),
          ),
        ),
    )

    const result = Service.of({
      create: Effect.fn("V2Session.create")((input) =>
        locationMutation.withLock(
          Effect.gen(function* () {
            const sessionID = input.id ?? SessionSchema.ID.create()
            const recorded = yield* store.get(sessionID)
            if (recorded) return recorded
            const project = yield* projects.resolve(input.location.directory)
            yield* db
              .insert(ProjectTable)
              .values({ id: project.id, worktree: project.directory, vcs: project.vcs?.type, sandboxes: [] })
              .onConflictDoNothing()
              .run()
              .pipe(Effect.orDie)
            const now = Date.now()
            // Ownership is captured exactly once at creation. A disabled scheduler
            // still retains the active space so offline changes stay in its outbox.
            const syncSpaceID = (yield* syncSetup.config().pipe(Effect.catch(() => Effect.succeed(undefined))))
              ?.namespaceID
            const info = SessionV1.SessionInfo.make({
              id: sessionID,
              slug: Slug.create(),
              version: InstallationVersion,
              projectID: project.id,
              directory: input.location.directory,
              target: input.location.target,
              lastKnownTargetName: input.location.lastKnownTargetName,
              syncSpaceID,
              path: path.relative(project.directory, input.location.directory).replaceAll("\\", "/"),
              workspaceID: input.location.workspaceID ? WorkspaceV2.ID.make(input.location.workspaceID) : undefined,
              title: `New session - ${new Date(now).toISOString()}`,
              approvalMode: input.approvalMode ?? "normal",
              agent: input.agent,
              model: input.model
                ? {
                    id: ModelV2.ID.make(input.model.id),
                    providerID: input.model.providerID,
                    variant: input.model.variant,
                  }
                : undefined,
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: now, updated: now },
            })
            const projected = yield* events
              .publish(SessionV1.Event.Created, { sessionID, info }, { location: input.location })
              .pipe(
                Effect.as({ type: "created" } as const),
                Effect.catchDefect((defect) => {
                  if (!(defect instanceof SessionProjector.SessionAlreadyProjected)) {
                    return Effect.die(defect)
                  }
                  // Concurrent creation lost the projection race. The existing Session identity wins.
                  return store
                    .get(sessionID)
                    .pipe(
                      Effect.flatMap((session) =>
                        session ? Effect.succeed({ type: "existing", session } as const) : Effect.die(defect),
                      ),
                    )
                }),
              )
            if (projected.type === "existing") return projected.session
            // TODO: Restore recorded sessions onto replacement synchronized workspaces in a future API slice.
            return yield* result.get(sessionID).pipe(Effect.orDie)
          }),
        ),
      ),
      rebindLocation: Effect.fn("V2Session.rebindLocation")((input) =>
        locationMutation.withLock(
          activity.withExclusive(
            [input.sessionID],
            Effect.gen(function* () {
              const before = yield* store.get(input.sessionID)
              if (!before) return yield* new NotFoundError({ sessionID: input.sessionID })
              if (before.locationRevision !== input.expectedRevision)
                return yield* new LocationRebindError({
                  message: `Location revision changed: expected ${input.expectedRevision}, actual ${before.locationRevision}`,
                })
              if (
                before.location.directory === input.destination.directory &&
                before.location.workspaceID === input.destination.workspaceID &&
                JSON.stringify(before.location.target) === JSON.stringify(input.destination.target)
              )
                return { status: "unchanged" as const, revision: before.locationRevision, warnings: [] }
              const blockers = yield* locationBlockers(input.sessionID)
              if (blockers.length)
                return yield* new LocationRebindError({ message: `Session is not idle: ${blockers.join(", ")}` })

              // Materialize the candidate and prove its root can actually be used before
              // committing. Service construction alone does not reject a missing local path.
              const epoch = yield* db
                .select({ generation: SessionContextEpochTable.generation })
                .from(SessionContextEpochTable)
                .where(eq(SessionContextEpochTable.session_id, input.sessionID))
                .get()
                .pipe(Effect.orDie)
              const revision = input.expectedRevision + 1
              const contextGeneration = yield* Effect.scoped(
                Effect.gen(function* () {
                  const context = yield* locations.contextEffect(input.destination)
                  const filesystem = Context.get(context, FileSystem.Service)
                  const status = yield* filesystem.directoryStatus(RelativePath.make("."))
                  if (status.status === "missing")
                    return yield* new LocationRebindError({ message: "Destination directory does not exist" })
                  if (status.status === "not-directory")
                    return yield* new LocationRebindError({ message: "Destination path is not a directory" })
                  // Listing is the least invasive cross-provider access check and catches
                  // unreadable local directories as well as Rexd filesystem denial.
                  yield* filesystem.list({ path: RelativePath.make(".") })
                  const assembler = Context.get(context, ModelContextAssembler.Service)
                  const assembled = yield* assembler.load(before.agent).pipe(
                    Effect.flatMap(SystemContext.initialize),
                    Effect.mapError(
                      () => new LocationRebindError({ message: "Destination model context is unavailable" }),
                    ),
                  )
                  return SessionContextEpoch.materialize(assembled, {
                    generation: (epoch?.generation ?? 0) + 1,
                    reason: "location-rebound",
                    locationRevision: revision,
                  })
                }),
              ).pipe(
                Effect.catchDefect(
                  () => new LocationRebindError({ message: "Destination directory is not accessible" }),
                ),
              )
              const current = yield* store.get(input.sessionID)
              if (!current) return yield* new NotFoundError({ sessionID: input.sessionID })
              if (current.locationRevision !== input.expectedRevision)
                return yield* new LocationRebindError({ message: "Location revision changed during validation" })
              const finalBlockers = yield* locationBlockers(input.sessionID)
              if (finalBlockers.length)
                return yield* new LocationRebindError({
                  message: `Session became non-idle during validation: ${finalBlockers.join(", ")}`,
                })
              yield* events.publish(SessionEvent.LocationRebound, {
                sessionID: input.sessionID,
                timestamp: DateTime.makeUnsafe(Date.now()),
                previous: current.location,
                location: input.destination,
                revision,
                context: contextGeneration,
              })
              const warnings: string[] = []
              yield* locations.invalidate(current.location).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    warnings.push(`Old Location cleanup failed: ${String(cause)}`)
                  }),
                ),
              )
              yield* locationRuntime.rebound(input.sessionID).pipe(
                Effect.catch((cause) =>
                  Effect.sync(() => {
                    warnings.push(`Location runtime reset failed: ${String(cause)}`)
                  }),
                ),
              )
              return { status: "rebound" as const, revision, warnings }
            }),
          ),
        ),
      ),
      get: Effect.fn("V2Session.get")(function* (sessionID) {
        const session = yield* store.get(sessionID)
        if (!session) return yield* new NotFoundError({ sessionID })
        return session
      }),
      list: Effect.fn("V2Session.list")(function* (input = {}) {
        const direction = input.anchor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const sortColumn = SessionTable.time_created
        const conditions: SQL[] = []
        if ("directory" in input) conditions.push(eq(SessionTable.directory, input.directory))
        if (input.workspaceID) conditions.push(eq(SessionTable.workspace_id, input.workspaceID))
        if ("project" in input) conditions.push(eq(SessionTable.project_id, input.project))
        if (input.search) conditions.push(like(SessionTable.title, `%${input.search}%`))
        if (input.anchor) {
          conditions.push(
            order === "asc"
              ? or(
                  gt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), gt(SessionTable.id, input.anchor.id)),
                )!
              : or(
                  lt(sortColumn, input.anchor.time),
                  and(eq(sortColumn, input.anchor.time), lt(SessionTable.id, input.anchor.id)),
                )!,
          )
        }
        const query = db
          .select()
          .from(SessionTable)
          .where(conditions.length > 0 ? and(...conditions) : undefined)
          .orderBy(
            order === "asc" ? asc(sortColumn) : desc(sortColumn),
            order === "asc" ? asc(SessionTable.id) : desc(SessionTable.id),
          )
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return (direction === "previous" ? rows.toReversed() : rows).map((row) => fromRow(row))
      }),
      messages: Effect.fn("V2Session.messages")(function* (input) {
        yield* result.get(input.sessionID)
        const direction = input.cursor?.direction ?? "next"
        const requestedOrder = input.order ?? "desc"
        const order = direction === "previous" ? (requestedOrder === "asc" ? "desc" : "asc") : requestedOrder
        const anchor = input.cursor
          ? yield* db
              .select({ seq: SessionMessageTable.seq })
              .from(SessionMessageTable)
              .where(
                and(eq(SessionMessageTable.session_id, input.sessionID), eq(SessionMessageTable.id, input.cursor.id)),
              )
              .get()
              .pipe(Effect.orDie)
          : undefined
        if (input.cursor && !anchor) return []
        const boundary = anchor
          ? order === "asc"
            ? gt(SessionMessageTable.seq, anchor.seq)
            : lt(SessionMessageTable.seq, anchor.seq)
          : undefined
        const where = boundary
          ? and(eq(SessionMessageTable.session_id, input.sessionID), boundary)
          : eq(SessionMessageTable.session_id, input.sessionID)
        const query = db
          .select()
          .from(SessionMessageTable)
          .where(where)
          .orderBy(order === "asc" ? asc(SessionMessageTable.seq) : desc(SessionMessageTable.seq))
        const rows = yield* (input.limit === undefined ? query.all() : query.limit(input.limit).all()).pipe(
          Effect.orDie,
        )
        return yield* Effect.forEach(direction === "previous" ? rows.toReversed() : rows, decode)
      }),
      message: Effect.fn("V2Session.message")(function* (input) {
        const stored = yield* store.message(input.messageID)
        return stored?.sessionID === input.sessionID ? stored.message : undefined
      }),
      context: Effect.fn("V2Session.context")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* store.context(sessionID)
      }),
      modelContext: Effect.fn("V2Session.modelContext")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* SessionContextEpoch.inspect(db, sessionID)
      }),
      events: (input) =>
        Stream.unwrap(
          result
            .get(input.sessionID)
            .pipe(Effect.as(events.durable({ aggregateID: input.sessionID, after: input.after }))),
        ).pipe(Stream.filter((event): event is SessionEvent.DurableEvent => isDurableSessionEvent(event))),
      history: Effect.fn("V2Session.history")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* EventV2.readAggregate(db, {
          ...input,
          aggregateID: input.sessionID,
          manifest: SessionDurable,
        })
      }),
      prompt,
      promptTurn: Effect.fn("V2Session.promptTurn")((input) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const admitted = yield* prompt({ ...input, delivery: "queue", resume: false })
            const turn = { sessionID: admitted.sessionID, messageID: admitted.id }
            const cancel = Effect.gen(function* () {
              if (yield* SessionTurn.cancelPending(db, events, turn)) return
              if ((yield* SessionTurn.find(db, turn)) !== undefined) return
              yield* execution.interrupt(admitted.sessionID)
            })
            // Install cancellation cleanup before restoring interruption. The wake ticket
            // follows the generation guaranteed to observe this admission, even when an
            // unrelated active run fails while handing off.
            const exit = yield* restore(execution.wakeAndWait(admitted.sessionID)).pipe(
              Effect.onInterrupt(() => cancel),
              Effect.exit,
            )
            const settled = yield* SessionTurn.find(db, turn)
            if (settled !== undefined) return settled
            if (Exit.isSuccess(exit)) return yield* Effect.die("Session execution completed without settling its input")
            const outcome = Cause.hasInterrupts(exit.cause) ? ("cancelled" as const) : ("failed" as const)
            yield* SessionTurn.settle(db, events, {
              sessionID: admitted.sessionID,
              messageIDs: [admitted.id],
              outcome,
            })
            return outcome
          }),
        ),
      ),
      shell: Effect.fn("V2Session.shell")(function* () {
        return yield* new OperationUnavailableError({ operation: "shell" })
      }),
      skill: Effect.fn("V2Session.skill")(function* () {
        return yield* new OperationUnavailableError({ operation: "skill" })
      }),
      switchAgent: Effect.fn("V2Session.switchAgent")((input) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.gen(function* () {
            const location = yield* requireLocation(input.sessionID)
            yield* result.get(input.sessionID)
            yield* events.publish(SessionEvent.AgentSwitched, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              agent: input.agent,
            })
            const session = yield* result.get(input.sessionID)
            yield* activateCatalog(session, location, false)
          }),
        ),
      ),
      switchModel: Effect.fn("V2Session.switchModel")((input) =>
        activity.withActivity(
          input.sessionID,
          "session_mutation",
          Effect.gen(function* () {
            yield* requireLocation(input.sessionID)
            const session = yield* result.get(input.sessionID)
            if (
              session.model?.providerID === input.model.providerID &&
              session.model.id === input.model.id &&
              (session.model.variant ?? "default") === (input.model.variant ?? "default")
            )
              return
            yield* events.publish(SessionEvent.ModelSwitched, {
              sessionID: input.sessionID,
              messageID: SessionMessage.ID.create(),
              timestamp: yield* DateTime.now,
              model: input.model,
            })
          }),
        ),
      ),
      compact: Effect.fn("V2Session.compact")(function* (input) {
        yield* result.get(input.sessionID)
        return yield* new OperationUnavailableError({ operation: "compact" })
      }),
      wait: Effect.fn("V2Session.wait")(function* (sessionID) {
        yield* result.get(sessionID)
        return yield* new OperationUnavailableError({ operation: "wait" })
      }),
      active: execution.active,
      activate: Effect.fn("V2Session.activate")((sessionID) =>
        activity.withActivity(
          sessionID,
          "session_mutation",
          Effect.gen(function* () {
            const location = yield* requireLocation(sessionID)
            const session = yield* result.get(sessionID)
            return yield* activateCatalog(session, location, true)
          }),
        ),
      ),
      locationBlockers,
      resume: Effect.fn("V2Session.resume")((sessionID) =>
        activity.withActivity(
          sessionID,
          "session_mutation",
          Effect.gen(function* () {
            const location = yield* requireLocation(sessionID)
            const session = yield* result.get(sessionID)
            const activation = yield* activateCatalog(session, location, true)
            if (activation.status === "unavailable")
              return yield* new OperationUnavailableError({ operation: "modelContext" })
            yield* execution.resume(sessionID)
          }),
        ),
      ),
      interrupt: Effect.fn("V2Session.interrupt")((sessionID) =>
        Effect.uninterruptible(execution.interrupt(sessionID)),
      ),
      revert: {
        stage: Effect.fn("V2Session.revert.stage")((input) =>
          activity.withActivity(
            input.sessionID,
            "session_mutation",
            Effect.gen(function* () {
              yield* requireLocation(input.sessionID)
              const session = yield* result.get(input.sessionID)
              return yield* SessionRevert.stage({ session, messageID: input.messageID, files: input.files }).pipe(
                Effect.provideService(Database.Service, database),
                Effect.provideService(EventV2.Service, events),
                Effect.provide(locations.get(session.location)),
              )
            }),
          ),
        ),
        clear: Effect.fn("V2Session.revert.clear")((sessionID) =>
          activity.withActivity(
            sessionID,
            "session_mutation",
            Effect.gen(function* () {
              yield* requireLocation(sessionID)
              const session = yield* result.get(sessionID)
              yield* SessionRevert.clear(session).pipe(
                Effect.provideService(EventV2.Service, events),
                Effect.provide(locations.get(session.location)),
              )
            }),
          ),
        ),
        commit: Effect.fn("V2Session.revert.commit")((sessionID) =>
          activity.withActivity(
            sessionID,
            "session_mutation",
            Effect.gen(function* () {
              yield* requireLocation(sessionID)
              const session = yield* result.get(sessionID)
              yield* SessionRevert.commit(session).pipe(Effect.provideService(EventV2.Service, events))
            }),
          ),
        ),
      },
    })

    return result
  }),
)

const resolvePrompt = (input: PromptInput.Prompt) =>
  Prompt.make({
    text: input.text,
    agents: input.agents,
    files: input.files?.map((file) => {
      const dataMime = file.uri.match(/^data:([^;,]+)[;,]/i)?.[1]
      const target = URL.canParse(file.uri) ? new URL(file.uri).pathname : (file.name ?? file.uri)
      return {
        ...file,
        mime: dataMime ?? (target.endsWith("/") ? "application/x-directory" : FSUtil.mimeType(target)),
      }
    }),
  })

export const node = makeGlobalNode({
  service: Service,
  layer: layer.pipe(Layer.orDie),
  deps: [
    Database.node,
    EventV2.node,
    ProjectV2.node,
    SessionExecution.node,
    SessionStore.node,
    LocationServiceMap.node,
    SessionProjector.node,
    SessionActivity.node,
    SessionLocationAccess.node,
    SessionLocationMutation.node,
    SessionLocationRuntime.node,
    SyncSetup.node,
  ],
})
