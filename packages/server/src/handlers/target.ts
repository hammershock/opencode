import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { TargetBindingRegistry } from "@opencode-ai/core/target-binding-registry"
import { SessionLocationRebinding } from "@opencode-ai/core/session-location-rebinding"
import { SessionV2 } from "@opencode-ai/core/session"
import {
  ConflictError,
  ForbiddenError,
  InvalidRequestError,
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
  return new UnknownError({ message: "Target registry operation failed", ref: "target_registry" })
}

export const TargetHandler = HttpApiBuilder.group(Api, "server.target", (handlers) =>
  Effect.gen(function* () {
    const target = yield* TargetRegistry.Service
    const bindings = yield* TargetBindingRegistry.Service
    const sessions = yield* SessionV2.Service
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
        invoke(() =>
          target.restoreMissing(
            ctx.params.targetID,
            ctx.payload.input,
            ctx.payload.referencedSessionIDs,
            ctx.payload.expectedRevision,
          ),
        ),
      )
      .handle("target.test", (ctx) => invoke(() => target.testConnection(ctx.params.targetID)))
      .handle("target.prepare", (ctx) => invoke(() => target.prepare(ctx.params.targetID)))
      .handle("target.legacy.preview", () => read(target.previewLegacyImport))
      .handle("target.legacy.import", (ctx) =>
        invoke(() => target.importLegacy(ctx.payload.sourceRevision, ctx.payload.expectedRevision)),
      )
      .handle("target.resolveSession", (ctx) =>
        invoke(async () => {
          const session = await Effect.runPromise(sessions.get(ctx.params.sessionID))
          const snapshot = await target.load()
          const bindingSnapshot = await bindings.load()
          return SessionLocationRebinding.resolve({
            sessionID: session.id,
            location: session.location,
            portable: session.portableTargetLabel
              ? { label: session.portableTargetLabel, directory: session.location.directory }
              : undefined,
            targets: snapshot.targets,
            bindings: bindingSnapshot.bindings,
            referencedSessions: async (reference) => {
              const all = await Effect.runPromise(sessions.list())
              return all
                .filter((item) => {
                  if (reference.targetID)
                    return item.location.target.type === "rexd" && item.location.target.targetID === reference.targetID
                  return item.portableTargetLabel === reference.label
                })
                .map((item) => item.id)
            },
            probe: async (definition) => target.prepare(definition.id),
          })
        }),
      )
      .handle("target.bindingList", () =>
        invoke(async () => {
          const snapshot = await bindings.load()
          return { revision: snapshot.revision, bindings: Object.fromEntries(snapshot.bindings) }
        }),
      )
      .handle("target.bindPortable", (ctx) =>
        invoke(async () => {
          await validatePortableScope(sessions, ctx.params.portableTargetLabel, ctx.payload.expectedSessionIDs)
          const prepared = await target.prepare(ctx.payload.targetID)
          if (prepared.status !== "ready") throw new Error(`${prepared.stage}: ${prepared.message}`)
          const snapshot = await bindings.bind(
            ctx.params.portableTargetLabel,
            ctx.payload.targetID,
            ctx.payload.expectedRevision,
          )
          return { revision: snapshot.revision, bindings: Object.fromEntries(snapshot.bindings) }
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
  expectedSessionIDs: readonly string[],
) {
  const actual = (await Effect.runPromise(sessions.list()))
    .filter((item) => item.portableTargetLabel === label)
    .map((item) => item.id)
    .sort()
  const expected = [...new Set(expectedSessionIDs)].sort()
  if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index]))
    throw new PortableScopeChangedError(label)
}
