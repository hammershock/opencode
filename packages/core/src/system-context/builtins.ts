export * as SystemContextBuiltIns from "./builtins"

import { makeLocationNode } from "../effect/app-node"
import { DateTime, Effect, Layer, Schema } from "effect"
import { Location } from "../location"
import { SystemContext } from "./index"
import { InstructionContext } from "../instruction-context"
import { SystemContextRegistry } from "./registry"
import { FSUtil } from "../fs-util"
import { Global } from "../global"
import { ModelContext } from "@opencode-ai/schema/model-context"

const builtIns = Layer.effectDiscard(
  Effect.gen(function* () {
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const environment = ModelContext.Environment.make({
      harness: "OpenCode REXD",
      entrypoint: "opencode-rexd",
      targetKind: location.target.type,
      targetName:
        location.targetName ?? location.lastKnownTargetName ?? (location.target.type === "local" ? "local" : "remote"),
      directory: location.directory,
      projectRoot: location.project.directory,
      vcs: location.vcs?.type,
      platform: location.platform ?? "unknown",
    })
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
    const context = SystemContext.combine([
      SystemContext.make({
        key: SystemContext.Key.make("core/environment"),
        refresh: "generation",
        codec: Schema.toCodecJson(ModelContext.Environment),
        load: Effect.succeed(environment),
        baseline: renderEnvironment,
        update: (_previous, environment) => `The execution environment is now:\n${renderEnvironment(environment)}`,
      }),
      SystemContext.make({
        key: SystemContext.Key.make("core/date"),
        codec: Schema.toCodecJson(ModelContext.ControllerTime),
        load: DateTime.nowAsDate.pipe(
          Effect.map((date) => ModelContext.ControllerTime.make({ date: date.toDateString(), timezone })),
        ),
        baseline: (time) => `Current date: ${time.date}\nUser timezone: ${time.timezone}`,
        update: (_previous, time) => `Current date: ${time.date}\nUser timezone: ${time.timezone}`,
      }),
    ])

    yield* registry.register({ key: SystemContext.Key.make("core/builtins"), load: Effect.succeed(context) })
  }),
)

export const node = makeLocationNode({
  name: "system-context-builtins",
  layer: builtIns,
  deps: [Location.node, SystemContextRegistry.node, InstructionContext.node, FSUtil.locationNode, Global.node],
})

function renderEnvironment(environment: ModelContext.Environment) {
  return [
    `Execution harness: ${environment.harness} (${environment.entrypoint})`,
    "<environment>",
    `  Target: ${environment.targetKind} (${environment.targetName})`,
    `  Working directory: ${environment.directory}`,
    `  Project root: ${environment.projectRoot}`,
    `  VCS: ${environment.vcs ?? "none"}`,
    `  Platform: ${environment.platform}`,
    "</environment>",
  ].join("\n")
}
