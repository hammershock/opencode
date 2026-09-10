import { Context, Effect, Layer } from "effect"
import { Info, LocalTarget, Ref, RexdTarget, Target, TargetID, response } from "@opencode-ai/schema/location"
import { Project } from "./project"
import { LayerNode } from "./effect/layer-node"
import { makeLocationNode, tags } from "./effect/app-node"
import { FSUtil } from "./fs-util"

export * as Location from "./location"

export { Info, LocalTarget, Ref, RexdTarget, Target, TargetID, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
  /** Platform of the actual execution target, never the controller for a Rexd Location. */
  readonly platform?: string
  /** Non-sensitive user-facing target identity. */
  readonly targetName?: string
  readonly home?: string
  /** Canonical target-side form used for containment and discovery; directory remains the user-facing logical path. */
  readonly canonicalDirectory?: string
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (input: Parameters<typeof Ref.make>[0]) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const ref = Ref.make(input)
      const project = yield* Project.Service
      const fs = yield* FSUtil.Service
      const resolved = yield* project.resolve(ref.directory)
      // Historical/local Session paths can disappear between sync and model-context
      // inspection. Keep the logical path as a conservative identity here; actual
      // execution and rebind flows perform their own directory availability checks.
      const canonicalDirectory = yield* fs.resolve(ref.directory).pipe(Effect.orElseSucceed(() => ref.directory))
      // Project.resolve uses the global project for a non-Git directory. That
      // identity is useful for storage, but `/` is not the model's project
      // boundary: the Session's selected directory is the non-Git fallback.
      const projectDirectory = resolved.vcs ? resolved.directory : ref.directory
      return Service.of({
        target: ref.target,
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        lastKnownTargetName: ref.lastKnownTargetName,
        project: { id: resolved.id, directory: projectDirectory },
        vcs: resolved.vcs,
        platform: `${process.platform}-${process.arch}`,
        targetName: ref.lastKnownTargetName ?? "local",
        home: process.env.HOME,
        canonicalDirectory,
      })
    }),
  )

export const boundNode = (ref: Parameters<typeof Ref.make>[0]) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node, FSUtil.locationNode],
  })
