import { describe, expect, test } from "bun:test"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { LocationEnvironmentWorkflow } from "@opencode-ai/core/location-environment-workflow"
import { SessionV2 } from "@opencode-ai/core/session"
import { Effect } from "effect"
import { initialize } from "../src/handlers/environment"

const sessionID = SessionV2.ID.make("ses_environment_workflow")

describe("EnvironmentHandler.initialize", () => {
  test("delegates the complete transaction to the Core workflow", async () => {
    const calls: string[] = []
    const environment = fixture(calls)
    const result = await Effect.runPromise(
      initialize(sessionID).pipe(
        Effect.provideService(LocationEnvironment.Service, environment),
        Effect.provideService(
          LocationEnvironmentWorkflow.AgentTurn,
          LocationEnvironmentWorkflow.AgentTurn.of({
            invoke: (input) =>
              Effect.sync(() => {
                expect(input.sessionID).toBe(sessionID)
                expect(input.prompt).toBe(LocationEnvironmentWorkflow.PROMPT)
                calls.push("agent")
                return "completed"
              }),
          }),
        ),
      ),
    )
    expect(result).toEqual({ status: "completed", template: "created", generation: 2 })
    expect(calls).toEqual(["template", "agent", "reload"])
  })

  test("does not reload after the Agent adapter cancels", async () => {
    const calls: string[] = []
    const result = await Effect.runPromise(
      initialize(sessionID).pipe(
        Effect.provideService(LocationEnvironment.Service, fixture(calls, "existing")),
        Effect.provideService(
          LocationEnvironmentWorkflow.AgentTurn,
          LocationEnvironmentWorkflow.AgentTurn.of({ invoke: () => Effect.succeed("cancelled") }),
        ),
      ),
    )
    expect(result).toEqual({ status: "cancelled", template: "existing" })
    expect(calls).toEqual(["template"])
  })
})

function fixture(calls: string[], template: "created" | "existing" = "created") {
  return LocationEnvironment.Service.of({
    snapshot: () => Effect.die("unused"),
    reload: () =>
      Effect.sync(() => {
        calls.push("reload")
        return {
          enabled: true,
          generation: 2,
          values: {},
          variables: [],
          sources: [],
        }
      }),
    environment: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    reveal: () => Effect.die("unused"),
    ensureTemplate: () =>
      Effect.sync(() => {
        calls.push("template")
        return template
      }),
    subscribe: () => Effect.die("unused"),
  })
}
