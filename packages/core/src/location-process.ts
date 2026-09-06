export * as LocationProcess from "./location-process"

import { Context, Duration, Effect, Layer, Option } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { makeLocationNode } from "./effect/app-node"
import { AppProcess } from "./process"
import { SessionActivity } from "./session/activity"
import { SessionSchema } from "./session/schema"

export interface RunOptions {
  readonly cwd: string
  readonly shell: string
  readonly env?: Readonly<Record<string, string>>
  readonly timeout: Duration.Input
  readonly maxOutputBytes: number
  readonly signal?: AbortSignal
  readonly sessionID?: SessionSchema.ID
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
    const activity = Option.getOrUndefined(yield* Effect.serviceOption(SessionActivity.Service))
    return Service.of({
      runShell: (command, options) => {
        const run = execution.run(
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
        )
        return options.sessionID && activity ? activity.withActivity(options.sessionID, "process_execution", run) : run
      },
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [AppProcess.node, SessionActivity.node] })
