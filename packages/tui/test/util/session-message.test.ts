import { describe, expect, test } from "bun:test"
import type { SessionMessage } from "@opencode-ai/sdk/v2"
import { projectCanonicalSessionMessages } from "../../src/util/session-message"

describe("projectCanonicalSessionMessages", () => {
  test("projects newest-first canonical user and assistant messages for the legacy transcript renderer", () => {
    const messages = [
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model", variant: "default" },
        content: [{ type: "text", id: "answer", text: "done" }],
        finish: "stop",
        time: { created: 20, completed: 30 },
      },
      {
        id: "user",
        type: "user",
        text: "$review inspect this",
        skills: [],
        time: { created: 10 },
      },
    ] satisfies SessionMessage[]

    const projected = projectCanonicalSessionMessages({
      sessionID: "session",
      directory: "/workspace",
      agent: "build",
      model: { providerID: "provider", id: "model", variant: "default" },
      messages,
    })

    expect(projected.map((item) => item.message.id)).toEqual(["user", "assistant"])
    expect(projected[0]?.message.role).toBe("user")
    expect(projected[0]?.parts).toMatchObject([{ type: "text", text: "$review inspect this" }])
    expect(projected[1]?.message).toMatchObject({ role: "assistant", parentID: "user", finish: "stop" })
    expect(projected[1]?.parts).toMatchObject([{ type: "text", text: "done" }])
  })

  test("projects canonical tool completion without losing the visible output", () => {
    const messages = [
      {
        id: "assistant",
        type: "assistant",
        agent: "build",
        model: { providerID: "provider", id: "model" },
        content: [
          {
            type: "tool",
            id: "call",
            name: "read",
            time: { created: 20, ran: 21, completed: 22 },
            state: {
              status: "completed",
              input: { filePath: "/workspace/file" },
              content: [{ type: "text", text: "contents" }],
              structured: {},
            },
          },
        ],
        time: { created: 20, completed: 30 },
      },
    ] satisfies SessionMessage[]

    const projected = projectCanonicalSessionMessages({
      sessionID: "session",
      directory: "/workspace",
      agent: "build",
      messages,
    })

    expect(projected[0]?.parts).toMatchObject([
      { type: "tool", callID: "call", tool: "read", state: { status: "completed", output: "contents" } },
    ])
  })
})
