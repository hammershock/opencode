export * as SkillTool from "./skill"

import { ToolFailure } from "@opencode-ai/llm"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SkillGuidanceSnapshot } from "../skill/guidance-snapshot"
import { SkillResolver } from "../skill/resolver"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill"

export const Input = Schema.Struct({
  name: Schema.String.annotate({ description: "The name of the skill from the available skills list" }),
})

export const Output = Schema.Struct({
  snapshot: SkillInvocation.Snapshot,
  output: Schema.String,
})

export const Structured = Schema.Struct({
  snapshot: SkillInvocation.Snapshot,
})

export const description = [
  "Load a specialized skill when the task at hand matches one of the available skills in the system context.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "The skill name must match one of the available skills in the system context.",
].join("\n")

export const toModelOutput = (snapshot: SkillInvocation.Snapshot) => {
  return [
    `<skill_content name="${snapshot.name}" invocation="${snapshot.id}">`,
    `# Skill: ${snapshot.name}`,
    "",
    snapshot.content.trim(),
    "",
    `Use skill_resource with skill "${snapshot.id}" to list or read auxiliary files from this Skill package.`,
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const resolver = yield* SkillResolver.Service
    yield* tools
      .register({
        [name]: Tool.make({
          description,
          input: Input,
          output: Output,
          structured: Structured,
          toStructuredOutput: ({ output }) => ({
            snapshot: SkillInvocation.Snapshot.make({
              ...output.snapshot,
              id: SkillInvocation.ID.make(output.snapshot.id),
              digest: Skill.Digest.make(output.snapshot.digest),
            }),
          }),
          toModelOutput: ({ output }) => [{ type: "text", text: output.output }],
          execute: (input, context) =>
            Effect.gen(function* () {
              const candidate = yield* resolver.resolveName({ agent: context.agent, name: input.name })
              yield* permission.assert({
                action: name,
                resources: [candidate.entry.metadata.name],
                save: [candidate.entry.metadata.name],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const resolved = yield* resolver.read(candidate)
              const snapshot = SkillInvocation.Snapshot.make({
                id: SkillInvocation.ID.make(
                  `ski_${Hash.sha256(
                    `${context.sessionID}\0${context.assistantMessageID}\0${context.toolCallID}\0${resolved.entry.metadata.name}\0${resolved.entry.metadata.digest}`,
                  )}`,
                ),
                name: resolved.entry.metadata.name,
                description: resolved.entry.metadata.description,
                digest: resolved.entry.metadata.digest,
                source: {
                  kind: resolved.entry.source.kind,
                  label: SkillGuidanceSnapshot.sourceLabel(resolved.entry.source.label),
                },
                content: resolved.entry.content,
                status: "loaded",
              })
              return { snapshot, output: toModelOutput(snapshot) }
            }).pipe(Effect.mapError((error) => unableToLoad(input.name, error))),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill",
  layer,
  deps: [ToolRegistry.node, SkillResolver.node, PermissionV2.node],
})
