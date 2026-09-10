import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillSettings } from "@opencode-ai/core/skill/settings"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { ConflictError, InvalidRequestError, UnknownError } from "@opencode-ai/protocol/errors"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"
import { Effect } from "effect"

const invoke = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({ try: operation, catch: (cause): unknown => cause }).pipe(Effect.mapError(mapDomainError))

function mapDomainError(cause: unknown) {
  if (cause instanceof SkillSettings.RevisionConflictError)
    return new ConflictError({ message: "Skill settings revision changed", resource: "opencode.jsonc" })
  if (cause instanceof SkillSettings.InvalidConfigError)
    return new InvalidRequestError({ message: "Skill settings configuration is invalid", kind: "skill_settings" })
  if (cause instanceof SkillSettings.InvalidPathError)
    return new InvalidRequestError({ message: "Skill discovery path is invalid", kind: "skill_path" })
  if (cause instanceof SkillSettings.InvalidUrlError)
    return new InvalidRequestError({ message: "Skill source URL is invalid", kind: "skill_url" })
  return new UnknownError({ message: "Skill settings operation failed", ref: "skill_settings" })
}

const read = <A>(operation: () => Promise<A>) =>
  Effect.tryPromise({
    try: operation,
    catch: () => new UnknownError({ message: "Skill settings operation failed", ref: "skill_settings" }),
  })

const useSkill = <A>(operation: (skill: SkillV2.Interface) => Effect.Effect<A>) =>
  PluginV2.Service.use((plugin) =>
    plugin.wait(PluginV2.ID.make("config-skill")).pipe(Effect.andThen(SkillV2.Service.use(operation))),
  )

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* SkillSettings.Service
    return handlers
      .handle("skill.list", () => response(useSkill((skill) => skill.list())))
      .handle("skill.catalog", (ctx) =>
        response(
          useSkill((skill) =>
            (ctx.query.forceReload === "true" ? skill.reload() : Effect.void).pipe(
              Effect.andThen(skill.catalog({ forceReload: ctx.query.forceReload === "true" })),
              Effect.map((value) => value.snapshot),
            ),
          ),
        ),
      )
      .handle("skill.reload", () =>
        response(
          useSkill((skill) =>
            skill.reload().pipe(
              Effect.andThen(skill.catalog({ forceReload: true })),
              Effect.map((value) => value.snapshot),
            ),
          ),
        ),
      )
      .handle("skill.settings", () => read(settings.load))
      .handle("skill.discoveryUpdate", (ctx) => invoke(() => settings.updateDiscovery(ctx.payload)))
      .handle("skill.discoveryReset", (ctx) => invoke(() => settings.resetDiscovery(ctx.payload.expectedRevision)))
      .handle("skill.targetScopeUpdate", (ctx) =>
        invoke(() => settings.updateTargetScope(ctx.params.skillID, ctx.payload.scope, ctx.payload.expectedRevision)),
      )
  }),
)
