import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { LocationEnvironmentWorkflow } from "@opencode-ai/core/location-environment-workflow"
import { SessionV2 } from "@opencode-ai/core/session"
import { InvalidRequestError } from "@opencode-ai/protocol/errors"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { Api } from "../api"
import { response } from "../location"

const invalid = (kind: string) =>
  Effect.mapError(() => new InvalidRequestError({ message: "Location environment operation failed", kind }))

export const initialize = Effect.fn("EnvironmentHandler.initialize")(function* (sessionID: SessionV2.ID) {
  const environment = yield* LocationEnvironment.Service
  const agent = yield* LocationEnvironmentWorkflow.AgentTurn
  return yield* LocationEnvironmentWorkflow.init(environment, (prompt) => agent.invoke({ sessionID, prompt }))
})

export const EnvironmentHandler = HttpApiBuilder.group(Api, "server.environment", (handlers) =>
  handlers
    .handle(
      "environment.list",
      Effect.fn(function* () {
        return yield* response((yield* LocationEnvironment.Service).list())
      }),
    )
    .handle(
      "environment.reload",
      Effect.fn(function* () {
        const environment = yield* LocationEnvironment.Service
        return yield* response(
          environment.reload().pipe(
            invalid("environment_reload"),
            Effect.flatMap(() => environment.list()),
          ),
        )
      }),
    )
    .handle(
      "environment.reveal",
      Effect.fn(function* () {
        const environment = yield* LocationEnvironment.Service
        const snapshot = yield* environment.snapshot()
        const reveal = yield* environment.reveal(true)
        const values = { generation: snapshot.generation, values: reveal.values() }
        reveal.close()
        return yield* response(Effect.succeed(values))
      }),
    )
    .handle(
      "environment.init",
      Effect.fn(function* (ctx) {
        return yield* response(initialize(ctx.params.sessionID).pipe(invalid("environment_init")))
      }),
    ),
)
