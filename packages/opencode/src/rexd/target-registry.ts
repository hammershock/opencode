import path from "node:path"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Global } from "@opencode-ai/core/global"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Effect, Layer } from "effect"
import { RexdError } from "./error"
import { testRexdConnection } from "./connection"

export const rexdTargetRegistryNode = makeGlobalNode({
  service: TargetRegistry.Service,
  layer: Layer.effect(
    TargetRegistry.Service,
    Effect.gen(function* () {
      const global = yield* Global.Service
      const probe: TargetRegistry.ConnectionProbe = {
        test: (target) => probeTarget(target),
        prepare: (target) => probeTarget(target),
      }
      return TargetRegistry.Service.of(
        TargetRegistry.make({
          directory: global.config,
          legacyFile: path.join(global.home, ".config", "rexd", "targets.json"),
          probe,
        }),
      )
    }),
  ),
  deps: [Global.node],
})

export async function probeTarget(
  target: TargetRegistry.Definition,
  test: typeof testRexdConnection = testRexdConnection,
): Promise<TargetRegistry.ProbeResult> {
  return test(target, {
    directory: target.defaultDirectory,
    clientVersion: InstallationVersion,
  })
    .then(
      () =>
        ({
          status: "ready",
          stages: ["ssh", "environment", "prepare", "handshake", "capabilities", "directory"],
        }) satisfies TargetRegistry.ProbeResult,
    )
    .catch((error: unknown) => ({
      status: error instanceof RexdError && !error.retryable ? ("invalid" as const) : ("unavailable" as const),
      stage: stage(error),
      message: error instanceof Error ? error.message : "Rexd target probe failed",
    }))
}

function stage(error: unknown): TargetRegistry.ConnectionStage {
  if (!(error instanceof RexdError)) return "ssh"
  if (error.phase === "detect") return "environment"
  if (error.phase === "download" || error.phase === "checksum" || error.phase === "install") return "prepare"
  if (error.phase === "handshake") return "handshake"
  if (error.phase === "capability") return "capabilities"
  if (error.phase === "directory") return "directory"
  return "ssh"
}
