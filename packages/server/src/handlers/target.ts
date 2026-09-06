import { TargetRegistry } from "@opencode-ai/core/target-registry"
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
  return new UnknownError({ message: "Target registry operation failed", ref: "target_registry" })
}

export const TargetHandler = HttpApiBuilder.group(Api, "server.target", (handlers) =>
  Effect.gen(function* () {
    const target = yield* TargetRegistry.Service
    return handlers
      .handle("target.list", () => read(target.load))
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
  }),
)
