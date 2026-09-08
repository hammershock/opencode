import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import { PermissionV2 } from "@opencode-ai/core/permission"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { SessionV2 } from "@opencode-ai/core/session"
import { GlobTool } from "@opencode-ai/core/tool/glob"
import { GrepTool } from "@opencode-ai/core/tool/grep"
import { ToolRegistry } from "@opencode-ai/core/tool/registry"
import { ToolOutputStore } from "@opencode-ai/core/tool-output-store"
import { location } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { settleTool, toolIdentity } from "./lib/tool"

const sessionID = SessionV2.ID.make("ses_search_tool_test")
const calls: Array<{ readonly method: "glob" | "grep"; readonly input: unknown }> = []
const filesystem = Layer.succeed(
  FileSystem.Service,
  FileSystem.Service.of({
    find: () => Effect.die("unused"),
    read: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    directoryStatus: () => Effect.die("unused"),
    ensureDirectory: () => Effect.die("unused"),
    glob: (input) =>
      Effect.sync(() => {
        calls.push({ method: "glob", input })
        return [FileSystem.Entry.make({ path: RelativePath.make("src/remote.ts"), type: "file" })]
      }),
    grep: (input) =>
      Effect.sync(() => {
        calls.push({ method: "grep", input })
        return [
          FileSystem.Match.make({
            entry: FileSystem.Entry.make({ path: RelativePath.make("src/remote.ts"), type: "file" }),
            line: 2,
            offset: 0,
            text: "remote marker",
            submatches: [],
          }),
        ]
      }),
  }),
)
const permission = Layer.succeed(
  PermissionV2.Service,
  PermissionV2.Service.of({
    assert: () => Effect.void,
    ask: () => Effect.die("unused"),
    reply: () => Effect.die("unused"),
    get: () => Effect.die("unused"),
    forSession: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
  }),
)
const activeLocation = Layer.succeed(
  Location.Service,
  Location.Service.of(location({ directory: AbsolutePath.make("/controller-invisible") })),
)
const runtime = AppNodeBuilder.build(
  LayerNode.group([ToolRegistry.node, ToolRegistry.toolsNode, GlobTool.node, GrepTool.node]),
  [
    [FileSystem.node, filesystem],
    [Location.node, activeLocation],
    [PermissionV2.node, permission],
    [ToolOutputStore.node, ToolOutputStore.nodeWithoutConfig],
  ],
)
const it = testEffect(runtime)

describe("Location search tools", () => {
  it.live("routes glob and grep through the Location filesystem service", () =>
    Effect.gen(function* () {
      calls.length = 0
      const registry = yield* ToolRegistry.Service
      const glob = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: { type: "tool-call", id: "call-glob", name: "glob", input: { pattern: "*.ts", path: "src" } },
      })
      const grep = yield* settleTool(registry, {
        sessionID,
        ...toolIdentity,
        call: {
          type: "tool-call",
          id: "call-grep",
          name: "grep",
          input: { pattern: "marker", path: "src" },
        },
      })

      expect(calls).toEqual([
        { method: "glob", input: { pattern: "*.ts", path: "src", limit: Number.MAX_SAFE_INTEGER } },
        {
          method: "grep",
          input: { pattern: "marker", path: "src", include: undefined, limit: Number.MAX_SAFE_INTEGER },
        },
      ])
      expect(glob.result).toEqual({ type: "text", value: "/controller-invisible/src/remote.ts" })
      expect(grep.result).toEqual({
        type: "text",
        value: "Found 1 matches\n/controller-invisible/src/remote.ts:\n  Line 2: remote marker",
      })
    }),
  )
})
