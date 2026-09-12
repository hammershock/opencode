import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillSettings } from "@opencode-ai/core/skill/settings"
import { PluginV2 } from "@opencode-ai/core/plugin"
import { SkillCatalogContextService } from "@opencode-ai/core/skill/catalog-context-service"
import { AgentV2 } from "@opencode-ai/core/agent"
import { ConflictError, InvalidRequestError, SkillNotFoundError, UnknownError } from "@opencode-ai/protocol/errors"
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

const useSkill = <A, E>(operation: (skill: SkillV2.Interface) => Effect.Effect<A, E>) =>
  PluginV2.Service.use((plugin) =>
    plugin.wait(PluginV2.INTERNAL_READY_ID).pipe(Effect.andThen(SkillV2.Service.use(operation))),
  )

const loadCatalog = (forceReload: boolean, agent?: string) =>
  SkillCatalogContextService.Service.use((catalog) => catalog.load({ forceReload })).pipe(
    Effect.map((value) => value.snapshot),
    Effect.flatMap((snapshot) => {
      if (agent === undefined) return Effect.succeed(snapshot)
      return AgentV2.Service.use((agents) => agents.select(agent)).pipe(
        Effect.map((selection) => SkillV2.preview(snapshot, selection.info)),
      )
    }),
  )

const loadManagementCatalog = (forceReload: boolean) =>
  SkillCatalogContextService.Service.use((catalog) => catalog.load({ forceReload, includeInactive: true })).pipe(
    Effect.map((value) => value.snapshot),
  )

const readSkill = (skillID: Parameters<SkillV2.Interface["read"]>[0]) =>
  useSkill((skill) => skill.read(skillID)).pipe(
    Effect.mapError((error) =>
      error.kind === "stale-catalog"
        ? new ConflictError({ message: "Skill changed; reload the catalog and try again", resource: "skill_catalog" })
        : error.kind === "malformed"
          ? new InvalidRequestError({ message: "Skill content is malformed", kind: "skill_content" })
          : new SkillNotFoundError({ skillID, message: "Skill is no longer available" }),
    ),
  )

export const SkillHandler = HttpApiBuilder.group(Api, "server.skill", (handlers) =>
  Effect.gen(function* () {
    const settings = yield* SkillSettings.Service
    return handlers
      .handle("skill.list", () => response(useSkill((skill) => skill.list())))
      .handle("skill.catalog", (ctx) => {
        if (ctx.query.includeInactive === "true")
          return response(loadManagementCatalog(ctx.query.forceReload === "true"))
        return response(loadCatalog(ctx.query.forceReload === "true", ctx.query.agent))
      })
      .handle("skill.get", (ctx) =>
        response(
          readSkill(ctx.params.skillID).pipe(
            Effect.flatMap((result) =>
              result.status === "missing"
                ? new SkillNotFoundError({
                    skillID: ctx.params.skillID,
                    message: "Skill is no longer available",
                  })
                : Effect.succeed(
                    SkillV2.Detail.make({
                      metadata: result.entry.metadata,
                      location: result.entry.location,
                      content: result.entry.content,
                    }),
                  ),
            ),
          ),
        ),
      )
      .handle("skill.reload", () => response(loadCatalog(true)))
      .handle("skill.settings", () => read(settings.load))
      .handle("skill.discoveryUpdate", (ctx) => invoke(() => settings.updateDiscovery(ctx.payload)))
      .handle("skill.discoveryReset", (ctx) => invoke(() => settings.resetDiscovery(ctx.payload.expectedRevision)))
      .handle("skill.targetScopeUpdate", (ctx) =>
        invoke(() => settings.updateTargetScope(ctx.params.skillID, ctx.payload.scope, ctx.payload.expectedRevision)),
      )
  }),
)
