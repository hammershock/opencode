import { LocationEnvironment } from "@opencode-ai/schema/location-environment"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const EnvironmentGroup = HttpApiGroup.make("server.environment")
  .add(
    HttpApiEndpoint.get("environment.list", "/api/environment", {
      query: LocationQuery,
      success: Location.response(LocationEnvironment.Snapshot),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.environment.list",
          summary: "List location environment metadata",
          description: "Lists names, origins, sources, and generation without exposing values.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("environment.reload", "/api/environment/reload", {
      query: LocationQuery,
      success: Location.response(LocationEnvironment.Snapshot),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.environment.reload",
          summary: "Reload location environment",
          description: "Atomically replaces the location snapshot after all target-side sources parse successfully.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("environment.reveal", "/api/environment/reveal", {
      query: LocationQuery,
      payload: Schema.Struct({ confirmed: Schema.Literal(true) }),
      success: Location.response(LocationEnvironment.Values),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.environment.reveal",
          summary: "Reveal location environment values",
          description:
            "Returns values only after explicit per-dialog confirmation; clients must discard them when the dialog closes.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.post("environment.init", "/api/environment/init", {
      query: LocationQuery,
      success: Location.response(LocationEnvironment.InitResult),
      error: InvalidRequestError,
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.environment.init",
          summary: "Ensure a project .env template",
          description: "Creates a deterministic template if absent; does not invoke an agent or reload by itself.",
        }),
      ),
  )
