import { Skill } from "@opencode-ai/schema/skill"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { LocationQuery, locationQueryOpenApi } from "./location"
import { ConflictError, InvalidRequestError, UnknownError } from "../errors"

const mutationErrors = [ConflictError, InvalidRequestError, UnknownError] as const
const catalogQuery = Schema.Struct({
  ...LocationQuery.fields,
  forceReload: Schema.Literals(["true", "false"]).pipe(Schema.optional),
}).annotate({ identifier: "Skill.CatalogQuery" })

export const SkillGroup = HttpApiGroup.make("server.skill")
  .add(
    HttpApiEndpoint.get("skill.list", "/api/skill", {
      query: LocationQuery,
      success: Location.response(Schema.Array(Skill.Info)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.list",
          summary: "List skills",
          description: "Retrieve currently registered skills.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("skill.catalog", "/api/skill/catalog", {
      query: catalogQuery,
      success: Location.response(Skill.RegistrySnapshot),
      error: UnknownError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.catalog",
          summary: "List controller Skill catalog metadata",
          description: "Returns metadata and diagnostics without Skill bodies.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("skill.reload", "/api/skill/reload", {
      query: LocationQuery,
      success: Location.response(Skill.RegistrySnapshot),
      error: UnknownError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.skill.reload",
          summary: "Reload controller Skill discovery",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("skill.settings", "/api/skill/settings", {
      success: Skill.SettingsSnapshot,
      error: UnknownError,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.skill.settings", summary: "Read device-local Skill settings" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("skill.discoveryUpdate", "/api/skill/settings/discovery", {
      payload: Skill.DiscoveryUpdate,
      success: Skill.SettingsSnapshot,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.skill.discovery.update", summary: "Replace imported Skill sources" }),
    ),
  )
  .add(
    HttpApiEndpoint.post("skill.discoveryReset", "/api/skill/settings/discovery/reset", {
      payload: Skill.RevisionInput,
      success: Skill.SettingsSnapshot,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.skill.discovery.reset", summary: "Reset to OpenCode Skill roots" }),
    ),
  )
  .add(
    HttpApiEndpoint.put("skill.targetScopeUpdate", "/api/skill/settings/:skillID/target-scope", {
      params: { skillID: Skill.ID },
      payload: Skill.TargetScopeUpdate,
      success: Skill.SettingsSnapshot,
      error: mutationErrors,
    }).annotateMerge(
      OpenApi.annotations({ identifier: "v2.skill.targetScope.update", summary: "Set Skill target availability" }),
    ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "skills",
      description: "Experimental skill routes.",
    }),
  )
