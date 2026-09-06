export * as LocationProcess from "./location-process"

import { Context, Duration, Effect, Layer } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "./effect/app-node"
import { AppProcess } from "./process"

export interface RunOptions {
  readonly cwd: string
  readonly shell: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout: Duration.Input
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
}

export interface Interface {
  readonly runShell: (
    command: string,
    options: RunOptions,
  ) => Effect.Effect<AppProcess.RunResult, AppProcess.AppProcessError>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationProcess") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const execution = yield* AppProcess.Service
    return Service.of({
      runShell: (command, options) =>
        execution.run(
          ChildProcess.make(command, [], {
            cwd: options.cwd,
            env: options.env,
            shell: options.shell,
            stdin: "ignore",
            detached: process.platform !== "win32",
            forceKillAfter: Duration.seconds(3),
          }),
          {
            combineOutput: true,
            timeout: options.timeout,
            maxOutputBytes: options.maxOutputBytes,
            signal: options.signal,
          },
        ),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [AppProcess.node] })
