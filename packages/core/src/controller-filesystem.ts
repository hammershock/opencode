export * as ControllerFileSystem from "./controller-filesystem"

import { Context, Effect, Layer } from "effect"
import { makeGlobalNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"

/** Controller-local filesystem retained even when a Location replaces the target filesystem. */
export class Service extends Context.Service<Service, FSUtil.Interface>()("@opencode/ControllerFileSystem") {}

const layer = Layer.effect(Service, FSUtil.Service.pipe(Effect.map((filesystem) => Service.of(filesystem))))

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node] })
