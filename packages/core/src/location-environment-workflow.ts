export * as LocationEnvironmentWorkflow from "./location-environment-workflow"

import { Effect } from "effect"
import { LocationEnvironment } from "./location-environment"

export type AgentResult = "completed" | "cancelled" | "failed"

export type InitResult =
  | { readonly status: "completed"; readonly template: "created" | "existing"; readonly generation: number }
  | { readonly status: "cancelled" | "failed"; readonly template: "created" | "existing" }

export const init = Effect.fn("LocationEnvironmentWorkflow.init")(function* (
  environment: LocationEnvironment.Interface,
  invokeAgent: (prompt: string) => Effect.Effect<AgentResult>,
) {
  const template = yield* environment.ensureTemplate()
  const result = yield* invokeAgent(
    "Review the project .env template and edit it through the normal workspace edit and permission flow. Do not copy values from the user-level environment. Finish after the project environment requirements are represented.",
  )
  if (result !== "completed") return { status: result, template } satisfies InitResult
  const snapshot = yield* environment.reload()
  return { status: "completed", template, generation: snapshot.generation } satisfies InitResult
})
