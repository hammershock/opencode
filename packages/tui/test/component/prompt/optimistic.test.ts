import { describe, expect, test } from "bun:test"
import { optimisticPrompt } from "../../../src/component/prompt/optimistic"

describe("optimistic prompt", () => {
  test("uses the same generated identities for the request and timeline projection", () => {
    const result = optimisticPrompt({
      sessionID: "ses_test",
      agent: "build",
      model: { providerID: "test", modelID: "model" },
      variant: "high",
      parts: [
        { type: "text", text: "hello" },
        { type: "file", mime: "text/plain", filename: "note.txt", url: "file:///note.txt" },
      ],
    })

    expect(result.message).toMatchObject({
      sessionID: "ses_test",
      role: "user",
      agent: "build",
      model: { providerID: "test", modelID: "model", variant: "high" },
    })
    expect(result.requestParts.map((part) => part.id)).toEqual(result.parts.map((part) => part.id))
    expect(result.parts).toEqual(
      result.requestParts.map((part) => ({ ...part, messageID: result.message.id, sessionID: "ses_test" })),
    )
  })
})
