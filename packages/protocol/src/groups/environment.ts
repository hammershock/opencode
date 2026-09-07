import { LocationEnvironment } from "@opencode-ai/schema/location-environment"
import { Location } from "@opencode-ai/schema/location"
import { Session } from "@opencode-ai/schema/session"
import { Context, Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

export const makeEnvironmentGroup = <
  LocationId extends HttpApiMiddleware.AnyId,
  LocationService,
  SessionLocationId extends HttpApiMiddleware.AnyId,
  SessionLocationService,
>(
  locationMiddleware: Context.Key<LocationId, LocationService>,
  sessionLocationMiddleware: Context.Key<SessionLocationId, SessionLocationService>,
) =>
  HttpApiGroup.make("server.environment")
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
    // Effect applies group middleware only to endpoints already added; init follows Session placement below.
    .middleware(locationMiddleware)
    .add(
      HttpApiEndpoint.post("environment.init", "/api/session/:sessionID/environment/init", {
        params: { sessionID: Session.ID },
        success: Location.response(LocationEnvironment.InitResult),
        error: InvalidRequestError,
      })
        .middleware(sessionLocationMiddleware)
        .annotateMerge(
          OpenApi.annotations({
            identifier: "v2.environment.init",
            summary: "Initialize a Session environment",
            description:
              "Ensures the project template, waits for one Agent turn, then reloads on successful completion.",
          }),
        ),
    )
