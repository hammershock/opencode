import { describe, expect, test } from "bun:test"
import { CommandRegistry, createHostResolver } from "@opencode-ai/command-kit"
import {
  modelContextCommand,
  type ModelContextCommandContext,
  type ModelContextGeneration,
} from "../../src/command-toolkit/model-context"
import { modelContextOptions } from "../../src/component/dialog-model-context"

const generation: ModelContextGeneration = {
  version: 1,
  generation: 2,
  reason: "init",
  locationRevision: 1,
  environment: {
    harness: "OpenCode Transit",
    entrypoint: "opencode-transit",
    targetKind: "rexd",
    targetName: "mywindows",
    directory: "/workspace/project",
    projectRoot: "/workspace/project",
    platform: "linux",
  },
  instructions: [
    {
      id: "global",
      origin: "global-file",
      scope: "global",
      source: "/controller/AGENTS.md",
      status: "loaded",
      content: "global rules",
      digest: "1111111111111111",
    },
    {
      id: "project",
      origin: "project-file",
      scope: "project",
      source: "/workspace/project/AGENTS.md",
      status: "ignored",
      failureStage: "read",
    },
  ],
  digest: "aaaaaaaaaaaaaaaa",
  baseline: "baseline",
  sources: {
    "core/environment": { value: {}, baseline: "environment body" },
    "core/date": { value: "date", baseline: "date body" },
    "core/instructions": { value: [] },
    "core/skills": { value: [], baseline: "skill body" },
  },
}

describe("model context inspector", () => {
  test("registers a trusted, read-only Session command", async () => {
    const registry = new CommandRegistry<ModelContextCommandContext>()
    registry.register(modelContextCommand)
    const resolution = createHostResolver(registry.routes(), () => undefined)("/context")
    expect(resolution.status).toBe("core")
    if (resolution.status !== "core") return
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    expect(prepared.status).toBe("parsed")
    if (prepared.status !== "parsed") return

    let inspected = 0
    let presented = false
    await prepared.execute({
      source: "slash",
      client: "tui",
      sessionID: "session",
      abortSignal: new AbortController().signal,
      confirm: async () => false,
      modelContext: {
        inspect: async () => {
          inspected++
          return generation
        },
      },
      presentModelContext: async (value) => {
        presented = value === generation
      },
    })
    expect(inspected).toBe(1)
    expect(presented).toBeTrue()
  })

  test("lists sources in their frozen injection order and exposes ignored diagnostics", () => {
    const options = modelContextOptions(generation)
    expect(options.map((option) => [option.category, option.title])).toEqual([
      ["Environment", "mywindows · rexd"],
      ["Context", "core/date"],
      ["Instructions", "/controller/AGENTS.md"],
      ["Instructions", "/workspace/project/AGENTS.md"],
      ["Context", "core/skills"],
    ])
    expect(options[2]?.value.content).toBe("global rules")
    expect(options[3]?.footer).toBe("read failed")
  })
})
