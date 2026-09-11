import { expect, test } from "bun:test"
import { SessionCompaction } from "@opencode-ai/core/session/compaction"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionMessage } from "@opencode-ai/core/session/message"
import { SessionV2 } from "@opencode-ai/core/session"
import { LLM, LLMEvent, Model, type LLMRequest } from "@opencode-ai/llm"
import { route } from "@opencode-ai/llm/protocols/openai-chat"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { ModelV2 } from "@opencode-ai/core/model"
import { ProviderV2 } from "@opencode-ai/core/provider"
import { DateTime, Effect, Stream } from "effect"

test("compaction prompt preserves detailed work state and relevant files", () => {
  const prompt = SessionCompaction.buildPrompt({ context: ["conversation history"] })

  expect(prompt).toStartWith(
    "Here is the conversation so far:\n\n<conversation>\nconversation history\n</conversation>",
  )
  expect(prompt.indexOf("</conversation>")).toBeLessThan(prompt.indexOf("Create a new anchored summary"))
  expect(prompt).toContain("conversation history in the <conversation> tags above")
  expect(prompt).toContain("## Work State\n### Completed")
  expect(prompt).toContain("### Active")
  expect(prompt).toContain("### Blocked")
  expect(prompt).toContain("## Relevant Files")
})

test("compaction prompt gives update instructions for a prior summary", () => {
  const prompt = SessionCompaction.buildPrompt({
    context: ["new conversation"],
    previousSummary: "existing summary",
  })

  expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf("<prior-summary>"))
  expect(prompt.indexOf("</prior-summary>")).toBeLessThan(prompt.indexOf("The <prior-summary> summarizes"))
  expect(prompt).toContain(
    "Carry forward objectives, constraints, user directives, decisions, and parallel workstreams from the <prior-summary>",
  )
  expect(prompt).toContain('Move completed work from "Active" to "Completed".')
  expect(prompt).toContain('Update "Objective" and "Next Move" to reflect the current work state.')
})

test("compaction describes tool media without embedding base64", () => {
  const base64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
  const serialized = SessionCompaction.serializeToolContent([
    { type: "text", text: "Image read successfully" },
    {
      type: "file",
      uri: `data:image/png;base64,${base64}`,
      mime: "image/png",
      name: "pixel.png",
    },
  ])

  expect(serialized).toBe("Image read successfully\n[Attached image/png: pixel.png]")
  expect(serialized).not.toContain(base64)
})

test("compaction carries exact Skill snapshots without re-reading their package", async () => {
  const published: Array<{ type: string; data: Record<string, unknown> }> = []
  const requests: LLMRequest[] = []
  const events = {
    publish: (type: { type: string }, data: Record<string, unknown>) =>
      Effect.sync(() => {
        published.push({ type: type.type, data })
        return {}
      }),
  } as unknown as EventV2.Interface
  const snapshot = SkillInvocation.Snapshot.make({
    id: SkillInvocation.ID.make("ski_compacted"),
    name: "review",
    digest: Skill.Digest.make("a".repeat(64)),
    source: { kind: "imported", label: "Imported" },
    content: "Exact durable Skill body",
    status: "loaded",
  })
  const implicit = SkillInvocation.Snapshot.make({
    ...snapshot,
    id: SkillInvocation.ID.make("ski_compactedimplicit"),
    content: "Exact durable implicit Skill body",
  })
  const model = Model.make({
    id: "compact",
    provider: "test",
    route: route.with({ limits: { context: 100_000, output: 100 } }),
  })
  const compaction = SessionCompaction.make({
    events,
    llm: {
      stream: (request) => {
        requests.push(request)
        return Stream.make(LLMEvent.textDelta({ id: "summary", text: "Preserved summary" }))
      },
    },
    config: [],
  })
  const compacted = await Effect.runPromise(
    compaction.compactAfterOverflow({
      sessionID: SessionV2.ID.make("ses_compaction_skill"),
      entries: [
        {
          seq: 1,
          message: SessionMessage.User.make({
            id: SessionMessage.ID.make("msg_compaction_skill"),
            type: "user",
            text: "Large request ".repeat(3_000),
            skills: [{ source: { start: 0, end: 7, text: "$review" }, snapshot }],
            time: { created: DateTime.makeUnsafe(1) },
          }),
        },
        {
          seq: 2,
          message: SessionMessage.Assistant.make({
            id: SessionMessage.ID.make("msg_compaction_skill_tool"),
            type: "assistant",
            agent: "build",
            model: { id: ModelV2.ID.make("model"), providerID: ProviderV2.ID.make("test") },
            content: [
              SessionMessage.AssistantTool.make({
                type: "tool",
                id: "call_compaction_skill",
                name: "skill",
                state: SessionMessage.ToolStateCompleted.make({
                  status: "completed",
                  input: { name: "review" },
                  content: [{ type: "text", text: "Skill loaded" }],
                  structured: { snapshot: implicit },
                }),
                time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
              }),
            ],
            time: { created: DateTime.makeUnsafe(2), completed: DateTime.makeUnsafe(3) },
          }),
        },
      ],
      model,
      request: LLM.request({ model, prompt: "continue" }),
    }),
  )

  expect(compacted).toBe(true)
  expect(published[1]).toMatchObject({
    type: "session.next.compaction.ended",
    data: { skills: [snapshot, implicit] },
  })
  expect(JSON.stringify(requests[0])).not.toContain(snapshot.content)
  expect(JSON.stringify(requests[0])).not.toContain(implicit.content)
})
