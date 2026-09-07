import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { TargetBindingRegistry } from "@opencode-ai/core/target-binding-registry"
import { SessionLocationRebinding } from "@opencode-ai/core/session-location-rebinding"
import { SessionV2 } from "@opencode-ai/core/session"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { Location } from "@opencode-ai/core/location"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
  SessionNotFoundError,
  TargetNotFoundError,
  UnknownError,
} from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"

const invoke = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause): unknown => cause }).pipe(Effect.mapError(mapDomainError))

const read = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new UnknownError({ message: "Target registry operation failed", ref: "target_registry" }),
  })

function mapDomainError(cause: unknown) {
  if (cause instanceof TargetRegistry.RevisionConflictError)
    return new ConflictError({ message: "Target registry revision changed", resource: "targets.jsonc" })
  if (cause instanceof TargetRegistry.InvalidConfigError)
    return new InvalidRequestError({ message: "Target registry configuration is invalid", kind: "target_config" })
  if (cause instanceof TargetRegistry.NameConflictError)
    return new ConflictError({ message: "Target name already exists", resource: cause.name })
  if (cause instanceof TargetRegistry.NotFoundError)
    return new TargetNotFoundError({ targetID: cause.targetID, message: "Target not found" })
  if (cause instanceof TargetRegistry.RestoreAuthorizationError)
    return new ForbiddenError({ message: "Target identity restoration was not authorized by Session recovery" })
  if (cause instanceof TargetBindingRegistry.RevisionConflictError)
    return new ConflictError({ message: "Target binding registry revision changed", resource: "target-bindings.json" })
  if (cause instanceof TargetBindingRegistry.InvalidLabelError)
    return new InvalidRequestError({ message: "Portable target label is invalid", kind: "target_binding" })
  if (cause instanceof PortableScopeChangedError)
    return new ConflictError({ message: cause.message, resource: cause.label })
  if (cause instanceof SessionLocationRebinding.RecoveryScopeChangedError)
    return new ConflictError({ message: "Session recovery scope changed", resource: "session-recovery" })
  if (cause instanceof SessionLocationRebinding.BindingRevisionConflictError)
    return new ConflictError({ message: "Target binding registry revision changed", resource: "target-bindings.json" })
  if (cause instanceof SessionLocationRebinding.RecoveryValidationError)
    return new InvalidRequestError({
      message: `Session Location validation failed: ${cause.failedSessionIDs.join(", ")}`,
      kind: "session_location_validation",
    })
  if (cause instanceof SessionLocationAccess.NotFoundError)
    return new SessionNotFoundError({ sessionID: cause.sessionID, message: `Session not found: ${cause.sessionID}` })
  if (cause instanceof SessionLocationAccess.UnresolvedError)
    return new InvalidRequestError({ message: cause.message, kind: `session_location_${cause.status}` })
  return new UnknownError({ message: "Target registry operation failed", ref: "target_registry" })
}

export const TargetHandler = HttpApiBuilder.group(Api, "server.target", (handlers) =>
  Effect.gen(function* () {
    const target = yield* TargetRegistry.Service
    const bindings = yield* TargetBindingRegistry.Service
    const sessions = yield* SessionV2.Service
    const access = yield* SessionLocationAccess.Service
    const referencedSessions = async (reference: {
      readonly targetID?: Location.TargetID
      readonly portableTargetLabel?: string
    }) =>
      (await Effect.runPromise(sessions.list()))
        .filter((item) =>
          reference.targetID
            ? item.location.target.type === "rexd" && item.location.target.targetID === reference.targetID
            : item.portableTargetLabel === reference.portableTargetLabel,
        )
        .map((item) => item.id)
    const recovery = SessionLocationRebinding.makeRecovery({
      referencedSessions,
      validateTargetInput: target.validate,
      restoreMissingTarget: async (input) =>
        (
          await target.restoreMissing(
            input.targetID,
            input.target,
            input.referencedSessionIDs,
            input.expectedRegistryRevision,
          )
        ).target,
      validateSessionLocation: async (_sessionID, location) => {
        if (location.target.type === "local") return
        const result = await target.prepare(location.target.targetID, location.directory)
        if (result.status !== "ready") throw new Error(`${result.stage}: ${result.message}`)
      },
      setPortableBinding: async (input) => ({
        revision: (await bindings.bind(input.portableTargetLabel, input.targetID, input.expectedRevision)).revision,
      }),
      readPortableBindingRevision: async () => (await bindings.load()).revision,
      publishGlobalDeletion: async () => {
        throw new Error("Global Session deletion is not part of target recovery")
      },
      removeLocalProjection: async () => {
        throw new Error("Global Session deletion is not part of target recovery")
      },
    })
    return handlers
      .handle("target.list", () => read(target.load))
      .handle("target.wizard.inspect", (ctx) => invoke(() => target.inspect(ctx.payload.input)))
      .handle("target.wizard.complete", (ctx) =>
        invoke(() =>
          target.complete(ctx.payload.input, {
            value: ctx.payload.value,
            cursor: ctx.payload.cursor,
            cwd: ctx.payload.cwd,
          }),
        ),
      )
      .handle("target.create", (ctx) => invoke(() => target.create(ctx.payload.input, ctx.payload.expectedRevision)))
      .handle("target.update", (ctx) =>
        invoke(() => target.update(ctx.params.targetID, ctx.payload.input, ctx.payload.expectedRevision)),
      )
      .handle("target.remove", (ctx) => invoke(() => target.remove(ctx.params.targetID, ctx.payload.expectedRevision)))
      .handle("target.restore", (ctx) =>
        invoke(async () => {
          const all = await Effect.runPromise(sessions.list())
          const result = await recovery.restoreMissing({
            targetID: ctx.params.targetID,
            target: ctx.payload.input,
            expectedSessionIDs: ctx.payload.referencedSessionIDs,
            expectedRegistryRevision: ctx.payload.expectedRevision,
            locations: new Map(all.map((session) => [session.id, session.location])),
          })
          return { ...result, snapshot: await target.load() }
        }),
      )
      .handle("target.test", (ctx) => invoke(() => target.testConnection(ctx.params.targetID)))
      .handle("target.prepare", (ctx) => invoke(() => target.prepare(ctx.params.targetID)))
      .handle("target.legacy.preview", () => read(target.previewLegacyImport))
      .handle("target.legacy.import", (ctx) =>
        invoke(() => target.importLegacy(ctx.payload.sourceRevision, ctx.payload.expectedRevision)),
      )
      .handle("target.resolveSession", (ctx) =>
        access.resolve(ctx.params.sessionID).pipe(Effect.mapError(mapDomainError)),
      )
      .handle("target.bindingList", () =>
        invoke(async () => {
          const snapshot = await bindings.load()
          return { revision: snapshot.revision, bindings: Object.fromEntries(snapshot.bindings) }
        }),
      )
      .handle("target.bindPortable", (ctx) =>
        invoke(async () => {
          const all = await Effect.runPromise(sessions.list())
          const result = await recovery.bindPortable({
            portableTargetLabel: ctx.params.portableTargetLabel,
            targetID: ctx.payload.targetID,
            expectedSessionIDs: ctx.payload.expectedSessionIDs,
            expectedBindingRevision: ctx.payload.expectedRevision,
            locations: new Map(
              all.map((session) => [
                session.id,
                Location.Ref.make({
                  ...session.location,
                  target: { type: "rexd", targetID: ctx.payload.targetID },
                  lastKnownTargetName: ctx.params.portableTargetLabel,
                }),
              ]),
            ),
          })
          const snapshot = await bindings.load()
          return {
            ...result,
            failedSessionIDs: [],
            bindings: Object.fromEntries(snapshot.bindings),
          }
        }),
      )
      .handle("target.unbindPortable", (ctx) =>
        invoke(async () => {
          await validatePortableScope(sessions, ctx.params.portableTargetLabel, ctx.payload.expectedSessionIDs)
          const snapshot = await bindings.unbind(ctx.params.portableTargetLabel, ctx.payload.expectedRevision)
          return { revision: snapshot.revision, bindings: Object.fromEntries(snapshot.bindings) }
        }),
      )
      .handle("target.rebindSession", (ctx) =>
        sessions
          .rebindLocation({ sessionID: ctx.params.sessionID, ...ctx.payload })
          .pipe(
            Effect.mapError(
              (cause) => new InvalidRequestError({ message: cause.message, kind: "session_location_rebind" }),
            ),
          ),
      )
  }),
)

class PortableScopeChangedError extends Error {
  constructor(readonly label: string) {
    super("Portable target recovery scope changed; review the affected Sessions again")
  }
}

async function validatePortableScope(
  sessions: SessionV2.Interface,
  label: string,
  expectedSessionIDs: readonly SessionSchema.ID[],
) {
  const actual = (await Effect.runPromise(sessions.list()))
    .filter((item) => item.portableTargetLabel === label)
    .map((item) => item.id)
    .sort()
  const expected = [...new Set(expectedSessionIDs)].sort()
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]))
    throw new PortableScopeChangedError(label)
}
