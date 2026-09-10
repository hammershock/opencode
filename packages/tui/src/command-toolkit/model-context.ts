import { defineCommand, type InvocationContext, type RawArguments } from "@opencode-ai/command-kit"

export type ModelContextGeneration = {
  version: 1
  generation: number
  reason: "created" | "legacy-backfill" | "location-rebound" | "init"
  locationRevision: number
  environment: {
    harness: "OpenCode REXD"
    entrypoint: "opencode-rexd"
    targetKind: "local" | "rexd"
    targetName: string
    directory: string
    projectRoot: string
    vcs?: string
    platform: string
  }
  instructions: ReadonlyArray<{
    id: string
    origin: "global-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
    scope: "global" | "project" | "nested"
    source: string
    declaredBy?: string
    status: "loaded" | "ignored"
    failureStage?: "discovery" | "read" | "fetch"
    content?: string
    digest?: string
  }>
  digest: string
  baseline: string
  sources: Readonly<Record<string, { value: unknown; baseline?: string; removed?: string; refresh?: "generation" }>>
}

export type ModelContextCommandContext = InvocationContext & {
  modelContext: {
    inspect: () => Promise<ModelContextGeneration | null>
  }
  presentModelContext: (generation: ModelContextGeneration | null) => Promise<void>
}

const empty = (raw: RawArguments) =>
  raw.value.trim()
    ? ({
        status: "invalid",
        code: "unexpected_arguments",
        message: "This command accepts no arguments",
        range: raw.range,
      } as const)
    : ({ status: "parsed", input: undefined } as const)

export const modelContextCommand = defineCommand<void, ModelContextCommandContext>({
  id: "fork.context.inspect",
  path: ["context"],
  title: "Model context",
  description: "Inspect the frozen model context for this Session",
  category: "Session",
  provenance: { type: "core", feature: "location-model-context" },
  requires: { session: true },
  capabilities: ["session.context.read"],
  parse: empty,
  execute: async (ctx) => {
    const generation = await ctx.modelContext.inspect()
    await ctx.presentModelContext(generation)
    return { status: "completed" }
  },
})
