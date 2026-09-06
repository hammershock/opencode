import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { LocationProcess } from "@opencode-ai/core/location-process"
import { AppProcess } from "@opencode-ai/core/process"
import { Duration, Effect, Layer, Result, Schema } from "effect"
import { RexdLocationSession } from "./location-session"

const Started = Schema.Struct({ process_id: Schema.String })
const Output = Schema.Struct({
  process_id: Schema.String,
  data: Schema.String,
  encoding: Schema.optional(Schema.Literals(["utf8", "base64"])),
})
const Exited = Schema.Struct({
  process_id: Schema.String,
  exit_code: Schema.NullOr(Schema.Number),
  signal: Schema.optional(Schema.NullOr(Schema.String)),
  timed_out: Schema.optional(Schema.Boolean),
})

export function rexdProcessNode(session: ReturnType<typeof import("./location-session").rexdSessionNode>) {
  return makeLocationNode({
    service: LocationProcess.Service,
    layer: Layer.effect(
      LocationProcess.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        return LocationProcess.Service.of({
          runShell: (command, options) =>
            Effect.tryPromise({
              try: () => run(lease, command, options),
              catch: (cause) => new AppProcess.AppProcessError({ command, cause }),
            }),
        })
      }),
    ),
    deps: [session],
  })
}

async function run(
  lease: import("./connection").RexdLease,
  command: string,
  options: LocationProcess.RunOptions,
): Promise<AppProcess.RunResult> {
  const output: Uint8Array[] = []
  let bytes = 0
  let truncated = false
  let processID: string | undefined
  let resolveExit = (_value: typeof Exited.Type) => undefined as void
  let rejectExit = (_cause: Error) => undefined as void
  const exited = new Promise<typeof Exited.Type>((resolve, reject) => {
    resolveExit = resolve
    rejectExit = reject
  })
  const receive = (method: string, params: unknown) => {
    if (method === "exec.exit") {
      const decoded = Schema.decodeUnknownResult(Exited)(params)
      if (Result.isSuccess(decoded) && decoded.success.process_id === processID) resolveExit(decoded.success)
      return
    }
    if (method !== "exec.stdout" && method !== "exec.stderr") return
    const decoded = Schema.decodeUnknownResult(Output)(params)
    if (Result.isFailure(decoded) || decoded.success.process_id !== processID) return
    const chunk = Buffer.from(decoded.success.data, decoded.success.encoding ?? "utf8")
    const remaining = options.maxOutputBytes - bytes
    if (remaining > 0) output.push(chunk.slice(0, remaining))
    bytes += chunk.length
    truncated ||= chunk.length > remaining
  }
  const pending: Array<[string, unknown]> = []
  const remove = lease.client.onNotification((method, params) => {
    if (!processID) return void pending.push([method, params])
    receive(method, params)
  })
  const started = Schema.decodeUnknownSync(Started)(
    await lease.client.request(
      "exec.start",
      {
        session_id: lease.handshake.sessionID,
        command,
        shell: true,
        login: false,
        cwd: options.cwd,
        env: options.env,
        timeout_ms: Duration.toMillis(options.timeout),
        max_output_bytes: options.maxOutputBytes,
      },
      { timeoutMs: 20_000, signal: options.signal, sideEffect: true },
    ),
  )
  processID = started.process_id
  pending.forEach(([method, params]) => receive(method, params))
  const abort = () => rejectExit(options.signal?.reason instanceof Error ? options.signal.reason : new Error("Aborted"))
  options.signal?.addEventListener("abort", abort, { once: true })
  const terminal = await exited
    .catch(async (cause) => {
      await lease.client
        .request(
          "exec.kill",
          { session_id: lease.handshake.sessionID, process_id: processID!, signal: "KILL" },
          { timeoutMs: 5_000, sideEffect: true },
        )
        .catch(() => undefined)
      throw cause
    })
    .finally(() => {
      remove()
      options.signal?.removeEventListener("abort", abort)
    })
  const combined = Buffer.concat(output)
  return {
    command,
    exitCode: terminal.exit_code ?? -1,
    output: combined,
    stdout: combined,
    stderr: Buffer.alloc(0),
    outputTruncated: truncated,
    stdoutTruncated: truncated,
    stderrTruncated: false,
  }
}
