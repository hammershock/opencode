import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { LocationEnvironmentAgentV2 } from "../src/location-environment-agent-v2"
import { LocationEnvironmentWorkflow } from "../src/location-environment-workflow"
import { SessionV2 } from "../src/session"

const sessionID = SessionV2.ID.make("ses_environment_workflow")

describe("LocationEnvironmentAgentV2", () => {
  test("waits for the exact durable prompt-turn result", async () => {
    const calls: string[] = []
    let finish!: () => void
    const done = new Promise<void>((resolve) => (finish = resolve))
    const agent = LocationEnvironmentAgentV2.make({
      promptTurn: (input) =>
        Effect.promise(async () => {
          expect(input).toMatchObject({ sessionID, prompt: { text: "instructions" } })
          calls.push("promptTurn")
          await done
          return "completed" as const
        }),
    })

    const result = Effect.runPromise(agent.invoke({ sessionID, prompt: "instructions" }))
    await Promise.resolve()
    expect(calls).toEqual(["promptTurn"])
    finish()
    expect(await result).toBe("completed")
  })

  test("classifies interruption as cancellation and other failures as failed", async () => {
    const cancelled = LocationEnvironmentAgentV2.make({ promptTurn: () => Effect.interrupt })
    expect(await Effect.runPromise(cancelled.invoke({ sessionID, prompt: "instructions" }))).toBe("cancelled")

    const failed = LocationEnvironmentAgentV2.make({
      promptTurn: () => Effect.fail(new SessionV2.NotFoundError({ sessionID })),
    })
    expect(await Effect.runPromise(failed.invoke({ sessionID, prompt: "instructions" }))).toBe("failed")
  })

  test("implements the workflow Agent-turn contract", () => {
    expect(LocationEnvironmentWorkflow.AgentTurn.key).toBe("@opencode/LocationEnvironmentWorkflowAgentTurn")
  })
})
