export * as SkillTool from "./skill"

import { ToolFailure } from "@opencode-ai/llm"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import { PermissionV2 } from "../permission"
import { SkillPresentation } from "../skill/presentation"
import { SkillPackageAccess } from "../skill/package-access"
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
  "Load one specialized skill when the task at hand matches its entry in <available_skills>.",
  "",
  "Use this tool to inject the skill's instructions and resources into the current conversation. The output may contain detailed workflow guidance as well as references to scripts, files, etc. in the same directory as the skill.",
  "",
  "This is not a Skill listing or search tool. To answer which Skills are available, read <available_skills> directly and do not call this tool.",
  'Never call this tool with invented operation names such as "list", "all", or "search".',
  "The name must exactly match one Skill in the current <available_skills> list.",
].join("\n")

export const toModelOutput = (snapshot: SkillInvocation.Snapshot, prepared?: SkillPackageAccess.Prepared) => {
  return [
    `<skill_content name="${snapshot.name}" invocation="${snapshot.id}">`,
    SkillPackageAccess.toModelContent({ name: snapshot.name, content: snapshot.content, prepared }),
    "</skill_content>",
  ].join("\n")
}

const unableToLoad = (name: string, error?: unknown) =>
  new ToolFailure({ message: `Unable to load skill ${name}`, error })

const resolutionFailure = (name: string, error: SkillResolver.Error) =>
  new ToolFailure({
    message:
      error.kind === "not_admitted"
        ? `Skill "${name}" is not available in this Session. Read <available_skills> directly; the skill tool does not list or search Skills.`
        : error.kind === "ambiguous_skill"
          ? `Skill "${name}" is ambiguous in this Session. Use an explicit $skill mention to choose its source.`
          : error.kind === "skill_inapplicable"
            ? `Skill "${name}" is no longer allowed for this Agent or execution target.`
            : `Skill "${name}" is no longer available on this device.`,
    error,
  })

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const permission = yield* PermissionV2.Service
    const resolver = yield* SkillResolver.Service
    const packages = yield* SkillPackageAccess.Service
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
              const candidate = yield* resolver
                .resolveName({ sessionID: context.sessionID, agent: context.agent, name: input.name })
                .pipe(Effect.mapError((error) => resolutionFailure(input.name, error)))
              yield* permission.assert({
                action: name,
                resources: [candidate.entry.metadata.name],
                save: [candidate.entry.metadata.name],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
              })
              const resolved = yield* resolver.read(candidate)
              const prepared = yield* packages.prepare({
                entry: resolved.entry,
                sessionID: context.sessionID,
              })
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
                  label: SkillPresentation.sourceLabel(resolved.entry.source.label),
                },
                content: resolved.entry.content,
                status: "loaded",
              })
              return { snapshot, output: toModelOutput(snapshot, prepared) }
            }).pipe(
              Effect.mapError((error) => (error instanceof ToolFailure ? error : unableToLoad(input.name, error))),
            ),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill",
  layer,
  deps: [ToolRegistry.node, SkillResolver.node, SkillPackageAccess.node, PermissionV2.node],
})
