import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LocationFormatter } from "@opencode-ai/core/location-formatter"
import { AppProcess } from "@opencode-ai/core/process"
import { Effect, Layer } from "effect"
import { runRexdProcess } from "./location-process"
import { RexdLocationSession } from "./location-session"

export function rexdFormatterNode(session: ReturnType<typeof import("./location-session").rexdSessionNode>) {
  return makeLocationNode({
    service: LocationFormatter.Service,
    layer: Layer.effect(
      LocationFormatter.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        return LocationFormatter.Service.of({
          run: (input) =>
            Effect.tryPromise({
              try: () =>
                runRexdProcess(lease, {
                  argv: input.argv,
                  shell: false,
                  cwd: input.cwd,
                  env: input.env,
                  timeout: "2 minutes",
                  maxOutputBytes: 256 * 1024,
                }).then((result) => result.exitCode),
              catch: (cause) => new AppProcess.AppProcessError({ command: input.argv.join(" "), cause }),
            }),
        })
      }),
    ),
    deps: [session],
  })
}
