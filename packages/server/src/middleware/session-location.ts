import { LocationServiceMap } from "@opencode-ai/core/location-services"
import { SessionLocationAccess } from "@opencode-ai/core/session/location-access"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/unstable/http"
import { HttpApiMiddleware } from "effect/unstable/httpapi"
import { InvalidRequestError, SessionNotFoundError } from "@opencode-ai/protocol/errors"
import type { LocationServices } from "../location"

export class SessionLocationMiddleware extends HttpApiMiddleware.Service<
  SessionLocationMiddleware,
  { provides: LocationServices }
>()("@opencode/HttpApiSessionLocation", {
  error: [InvalidRequestError, SessionNotFoundError],
}) {}

const decodeSessionID = Schema.decodeUnknownEffect(SessionV2.ID)

export const sessionLocationLayer = Layer.effect(
  SessionLocationMiddleware,
  Effect.gen(function* () {
    const locations = yield* LocationServiceMap.Service
    const access = yield* SessionLocationAccess.Service

    return SessionLocationMiddleware.of((effect) =>
      Effect.gen(function* () {
        const route = yield* HttpRouter.RouteContext
        const sessionID = yield* decodeSessionID(route.params.sessionID).pipe(
          Effect.mapError(
            () =>
              new InvalidRequestError({
                message: "Invalid session ID",
                field: "sessionID",
              }),
          ),
        )
        const location = yield* access.require(sessionID).pipe(
          Effect.catchTag(
            "SessionLocationAccess.NotFoundError",
            () => new SessionNotFoundError({ sessionID, message: `Session not found: ${sessionID}` }),
          ),
          Effect.catchTag(
            "SessionLocationAccess.UnresolvedError",
            (error) =>
              new InvalidRequestError({
                message: error.message,
                field: "sessionID",
                kind: `session_location_${error.status}`,
              }),
          ),
        )

        return yield* effect.pipe(Effect.provide(locations.get(location)))
      }),
    )
  }),
)
