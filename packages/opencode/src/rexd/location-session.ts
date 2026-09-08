import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { Hash } from "@opencode-ai/core/util/hash"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import type { RexdLease } from "./connection"
import { RexdConnectionPool } from "./connection-pool"

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
      Effect.gen(function* () {
        const registry = yield* TargetRegistry.Service
        const snapshot = yield* Effect.promise(() => registry.load())
        const target = snapshot.targets.find((item) => item.id === targetID)
        if (!target) return yield* Effect.die(new Error(`Rexd target is unavailable: ${targetID}`))
        const pool = yield* RexdConnectionPool.Service
        const handle = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            pool.acquire(target, { directory: ref.directory, clientVersion: InstallationVersion }),
          ),
          (current) => Effect.promise(() => current.release()),
        )
        return handle.lease
      }),
    ),
    deps: [TargetRegistry.node, RexdConnectionPool.node],
  })
}

export function rexdLocationNode(ref: Location.Ref, session: ReturnType<typeof rexdSessionNode>) {
  if (ref.target.type !== "rexd") throw new Error("Rexd provider received a local Location")
  const targetID = ref.target.targetID
  return makeLocationNode({
    service: Location.Service,
    layer: Layer.effect(
      Location.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        const project =
          lease.handshake.workspaceRoots
            .filter((root) => within(root, ref.directory))
            .sort((left, right) => right.length - left.length)[0] ?? ref.directory
        return Location.Service.of({
          target: ref.target,
          directory: ref.directory,
          workspaceID: ref.workspaceID,
          lastKnownTargetName: ref.lastKnownTargetName,
          project: {
            id: Project.ID.make(Hash.fast(`rexd:${targetID}:${project}`)),
            directory: AbsolutePath.make(project),
          },
        })
      }),
    ),
    deps: [session],
  })
}

function within(root: string, value: string) {
  const relative = path.posix.relative(path.posix.normalize(root), path.posix.normalize(value))
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative))
}
