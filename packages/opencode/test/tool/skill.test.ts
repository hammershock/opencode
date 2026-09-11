import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { LocationServiceMap, locationServiceMapLayer } from "@opencode-ai/core/location-services"
import { Effect, Layer } from "effect"
import { ToolRegistry } from "@/tool/registry"
import { testEffect } from "../lib/effect"

const it = testEffect(
  LayerNode.compile(LayerNode.group([ToolRegistry.node, CrossSpawnSpawner.node, Ripgrep.node]), [
    [LocationServiceMap.node, locationServiceMapLayer],
  ]),
)

describe("legacy tool registry Skill compatibility", () => {
  it.instance("does not register a second executable Skill tool", () =>
    Effect.gen(function* () {
      const registry = yield* ToolRegistry.Service
      const agent = { name: "build", mode: "primary" as const, permission: [], options: {} }
      expect(
        (yield* registry.tools({
          providerID: "opencode" as never,
          modelID: "gpt-5" as never,
          agent,
        })).some((tool) => tool.id === "skill"),
      ).toBe(false)
    }),
  )
})
