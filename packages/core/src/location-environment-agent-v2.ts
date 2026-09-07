export * as LocationEnvironmentAgentV2 from "./location-environment-agent-v2"

import { Cause, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { LocationEnvironmentWorkflow } from "./location-environment-workflow"
import { SessionV2 } from "./session"

export function make(session: Pick<SessionV2.Interface, "promptTurn">) {
  return LocationEnvironmentWorkflow.AgentTurn.of({
    invoke: Effect.fn("LocationEnvironmentAgentV2.invoke")(function* (input) {
      return yield* session
        .promptTurn({
          sessionID: input.sessionID,
          prompt: { text: input.prompt },
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.succeed(Cause.hasInterruptsOnly(cause) ? ("cancelled" as const) : ("failed" as const)),
          ),
        )
    }),
  })
}

export const layer = Layer.effect(
  LocationEnvironmentWorkflow.AgentTurn,
  Effect.gen(function* () {
    const session = yield* SessionV2.Service
    return make(session)
  }),
)

export const node = makeGlobalNode({
  service: LocationEnvironmentWorkflow.AgentTurn,
  layer,
  deps: [SessionV2.node],
})
