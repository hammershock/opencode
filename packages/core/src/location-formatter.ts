export * as LocationFormatter from "./location-formatter"

import { Context, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "./effect/app-node"
import { AppProcess } from "./process"

export interface Interface {
  readonly run: (input: {
    readonly argv: readonly [string, ...string[]]
    readonly cwd: string
    readonly env: Readonly<Record<string, string>>
  }) => Effect.Effect<number, AppProcess.AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationFormatter") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const process = yield* AppProcess.Service
    return Service.of({
      run: (input) =>
        process
          .run(
            ChildProcess.make(input.argv[0], input.argv.slice(1), {
              cwd: input.cwd,
              env: input.env,
              stdin: "ignore",
              stdout: "ignore",
              stderr: "ignore",
            }),
          )
          .pipe(Effect.map((result) => result.exitCode)),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [AppProcess.node] })
