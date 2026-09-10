import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LocationProcess } from "@opencode-ai/core/location-process"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer } from "effect"
import { RexdLocationSession } from "./location-session"
import { SessionActivity } from "@opencode-ai/core/session/activity"
import { runRexdProcess } from "./process-runner"

export { runRexdProcess } from "./process-runner"

export function rexdProcessNode(session: ReturnType<typeof import("./location-session").rexdSessionNode>) {
  return makeLocationNode({
    service: LocationProcess.Service,
    layer: Layer.effect(
      LocationProcess.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        const activity = yield* SessionActivity.Service
        return LocationProcess.Service.of({
          runShell: (command, options) => {
            const run = Effect.tryPromise({
              try: () =>
                runRexdProcess(lease, {
                  command,
                  shell: true,
                  cwd: options.cwd,
                  env: options.env,
                  timeout: options.timeout,
                  maxOutputBytes: options.maxOutputBytes,
                  signal: options.signal,
                }),
              catch: (cause) => new AppProcess.AppProcessError({ command, cause }),
            })
            return options.sessionID ? activity.withActivity(options.sessionID, "process_execution", run) : run
          },
        })
      }),
    ),
    deps: [session, SessionActivity.node],
  })
}
