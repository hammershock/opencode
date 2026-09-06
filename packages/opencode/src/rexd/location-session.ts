import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { Hash } from "@opencode-ai/core/util/hash"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Context, Effect, Layer } from "effect"
import { connectRexd, type RexdLease } from "./connection"

export class RexdLocationSession extends Context.Service<RexdLocationSession, RexdLease>()(
  "@opencode/RexdLocationSession",
) {}

export function rexdSessionNode(ref: Location.Ref) {
  if (ref.target.type !== "rexd") throw new Error("Rexd provider received a local Location")
  const targetID = ref.target.targetID
  return makeLocationNode({
    service: RexdLocationSession,
    layer: Layer.effect(
      RexdLocationSession,
      Effect.acquireRelease(
        Effect.gen(function* () {
          const registry = yield* TargetRegistry.Service
          const snapshot = yield* Effect.promise(() => registry.load())
          const target = snapshot.targets.find((item) => item.id === targetID)
          if (!target) return yield* Effect.die(new Error(`Rexd target is unavailable: ${targetID}`))
          return yield* Effect.tryPromise(() =>
            connectRexd(target, { directory: ref.directory, clientVersion: InstallationVersion }),
          )
        }),
        (lease) => Effect.promise(() => lease.close()),
      ),
    ),
    deps: [TargetRegistry.node],
  })
}

export function rexdLocationNode(ref: Location.Ref) {
  if (ref.target.type !== "rexd") throw new Error("Rexd provider received a local Location")
  return makeLocationNode({
    service: Location.Service,
    layer: Layer.succeed(
      Location.Service,
      Location.Service.of({
        target: ref.target,
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        lastKnownTargetName: ref.lastKnownTargetName,
        project: {
          id: Project.ID.make(Hash.fast(`rexd:${ref.target.targetID}:${ref.directory}`)),
          directory: AbsolutePath.make(ref.directory),
        },
      }),
    ),
    deps: [],
  })
}
