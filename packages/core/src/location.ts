import { Context, Effect, Layer } from "effect"
import { Info, LocalTarget, Ref, RexdTarget, Target, TargetID, response } from "@opencode-ai/schema/location"
import { Project } from "./project"
import { LayerNode } from "./effect/layer-node"
import { makeLocationNode, tags } from "./effect/app-node"

export * as Location from "./location"

export { Info, LocalTarget, Ref, RexdTarget, Target, TargetID, response }

export interface Interface extends Info {
  readonly vcs?: Project.Vcs
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Location") {}

export const node = LayerNode.unbound(Service, tags.values.location)

const layer = (input: Parameters<typeof Ref.make>[0]) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const ref = Ref.make(input)
      const project = yield* Project.Service
      const resolved = yield* project.resolve(ref.directory)
      return Service.of({
        target: ref.target,
        directory: ref.directory,
        workspaceID: ref.workspaceID,
        lastKnownTargetName: ref.lastKnownTargetName,
        project: { id: resolved.id, directory: resolved.directory },
        vcs: resolved.vcs,
      })
    }),
  )

export const boundNode = (ref: Parameters<typeof Ref.make>[0]) =>
  makeLocationNode({
    service: Service,
    layer: layer(ref),
    deps: [Project.node],
  })
