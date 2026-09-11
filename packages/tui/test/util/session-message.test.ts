import { describe, expect, test } from "bun:test"
import type { Message, SessionMessage, SessionMessageUser } from "@opencode-ai/sdk/v2"
import {
  canonicalUserText,
  commitCanonicalRevert,
  mergeCanonicalSessionMessages,
  projectCanonicalSessionMessages,
  restoreCanonicalPrompt,
} from "../../src/util/session-message"

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

  test("restores a canonical skill mention without exposing its injected content", () => {
    const message = {
      id: "user",
      type: "user",
      text: "$review inspect this",
      time: { created: 10 },
      skills: [
        {
          source: { start: 0, end: 7, text: "$review" },
          snapshot: {
            id: "ski_invocation",
            name: "review",
            digest: "digest",
            source: { kind: "imported", label: "Codex" },
            content: "private injected instructions",
            status: "loaded",
          },
        },
      ],
    } satisfies SessionMessageUser

    expect(canonicalUserText(message)).toBe("$review inspect this")
    expect(
      restoreCanonicalPrompt(message, [
        { id: "skl_catalog", name: "review", sourceLabel: "Codex · deadbeef", digest: "digest" },
      ]),
    ).toEqual({
      prompt: {
        input: "$review inspect this",
        parts: [
          {
            type: "skill",
            id: "skl_catalog",
            name: "review",
            description: undefined,
            sourceLabel: "Codex · deadbeef",
            digest: "digest",
            source: { start: 0, end: 7, value: "$review" },
          },
        ],
      },
    })
    expect(
      JSON.stringify(
        restoreCanonicalPrompt(message, [
          { id: "skl_catalog", name: "review", sourceLabel: "Codex · deadbeef", digest: "digest" },
        ]),
      ),
    ).not.toContain("private injected instructions")
  })

  test("refuses to restore a skill mention that is no longer in the catalog", () => {
    const message = {
      id: "user",
      type: "user",
      text: "$review",
      time: { created: 10 },
      skills: [
        {
          source: { start: 0, end: 7, text: "$review" },
          snapshot: {
            id: "ski_invocation",
            name: "review",
            digest: "digest",
            source: { kind: "imported", label: "Codex" },
            content: "instructions",
            status: "loaded",
          },
        },
      ],
    } satisfies SessionMessageUser

    expect(restoreCanonicalPrompt(message, [])).toEqual({ missing: "review" })
  })

  test("commits a canonical revert through the boundary in newest-first storage order", () => {
    const messages = [
      { id: "later", type: "system", text: "later", time: { created: 3 } },
      { id: "boundary", type: "user", text: "$review", time: { created: 2 } },
      { id: "earlier", type: "system", text: "earlier", time: { created: 1 } },
    ] satisfies SessionMessage[]

    expect(commitCanonicalRevert(messages, "boundary").map((message) => message.id)).toEqual(["earlier"])
  })
})

describe("mergeCanonicalSessionMessages", () => {
  test("preserves durable order when admission timestamps cross assistant output", () => {
    const canonical = [
      { id: "input-1", role: "user", time: { created: 10 } },
      { id: "output-1", role: "assistant", time: { created: 30 } },
      { id: "input-2", role: "user", time: { created: 20 } },
      { id: "output-2", role: "assistant", time: { created: 40 } },
    ] as Message[]
    const legacy = canonical.toSorted((a, b) => a.time.created - b.time.created)

    expect(mergeCanonicalSessionMessages(legacy, canonical).map((message) => message.id)).toEqual([
      "input-1",
      "output-1",
      "input-2",
      "output-2",
    ])
  })

  test("keeps live legacy rows and prefers their objects for projected IDs", () => {
    const projected = { id: "input-1", role: "user", time: { created: 10 } } as Message
    const live = { ...projected, time: { created: 11 } } as Message
    const queued = { id: "input-2", role: "user", time: { created: 9 } } as Message

    expect(mergeCanonicalSessionMessages([queued, live], [projected])).toEqual([live, queued])
  })
})
