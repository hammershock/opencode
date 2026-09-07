import { LocationEnvironmentWorkflow } from "@opencode-ai/core/location-environment-workflow"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Effect, Layer } from "effect"
import { SessionPrompt } from "@/session/prompt"
import { MessageID } from "@/session/schema"

export function make(session: Pick<SessionPrompt.Interface, "prompt">) {
  return LocationEnvironmentWorkflow.AgentTurn.of({
    invoke: (input) => {
      const messageID = MessageID.ascending()
      return session
        .prompt({
          sessionID: input.sessionID,
          messageID,
          parts: [{ type: "text", text: input.prompt }],
        })
        .pipe(
          Effect.map((message) =>
            message.info.role !== "assistant" || message.info.parentID !== messageID
              ? ("failed" as const)
              : SessionV1.AbortedError.isInstance(message.info.error)
                ? ("cancelled" as const)
                : message.info.error
                  ? ("failed" as const)
                  : ("completed" as const),
          ),
          Effect.catchCause((cause) =>
            Effect.succeed(Cause.hasInterruptsOnly(cause) ? ("cancelled" as const) : ("failed" as const)),
          ),
        )
    },
  })
}

export const layer = Layer.effect(
  LocationEnvironmentWorkflow.AgentTurn,
  Effect.gen(function* () {
    const session = yield* SessionPrompt.Service
    return make(session)
  }),
)

export const node = makeGlobalNode({
  service: LocationEnvironmentWorkflow.AgentTurn,
  layer,
  deps: [SessionPrompt.node],
})

export * as LocationEnvironmentAgent from "./location-environment-agent"
