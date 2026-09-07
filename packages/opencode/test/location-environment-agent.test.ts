import { describe, expect, test } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { Effect } from "effect"
import { LocationEnvironmentAgent } from "../src/location-environment-agent"
import { MessageID, SessionID, type MessageID as MessageIDType } from "../src/session/schema"

const sessionID = SessionID.make("ses_environment_workflow")

describe("LocationEnvironmentAgent", () => {
  test("correlates completion with the exact admitted legacy user message", async () => {
    const agent = LocationEnvironmentAgent.make({
      prompt: (input) => (input.messageID ? Effect.succeed(assistant(input.messageID)) : Effect.die("missing id")),
    })
    expect(await Effect.runPromise(agent.invoke({ sessionID, prompt: "instructions" }))).toBe("completed")
  })

  test("does not accept an unrelated completed turn", async () => {
    const agent = LocationEnvironmentAgent.make({
      prompt: () => Effect.succeed(assistant(MessageID.make("msg_unrelated"))),
    })
    expect(await Effect.runPromise(agent.invoke({ sessionID, prompt: "instructions" }))).toBe("failed")
  })

  test("classifies native Agent cancellation without exposing its error", async () => {
    const agent = LocationEnvironmentAgent.make({
      prompt: (input) =>
        input.messageID
          ? Effect.succeed(assistant(input.messageID, new SessionV1.AbortedError({ message: "cancelled" }).toObject()))
          : Effect.die("missing id"),
    })
    expect(await Effect.runPromise(agent.invoke({ sessionID, prompt: "instructions" }))).toBe("cancelled")
  })
})

function assistant(parentID: MessageIDType, error?: SessionV1.Assistant["error"]): SessionV1.WithParts {
  return {
    info: {
      id: MessageID.ascending(),
      sessionID,
      role: "assistant",
      time: { created: 0 },
      parentID,
      modelID: ModelV2.ID.make("test-model"),
      providerID: ProviderV2.ID.make("test-provider"),
      mode: "build",
      agent: "build",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      error,
    },
    parts: [],
  }
}
