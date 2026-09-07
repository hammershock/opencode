import path from "node:path"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationProcess } from "@opencode-ai/core/location-process"
import { Location } from "@opencode-ai/core/location"
import { RelativePath } from "@opencode-ai/core/schema"
import { Duration, Effect, Exit } from "effect"
import { Shell } from "@opencode-ai/core/shell"
import { UserShellLocal } from "./user-shell-local"
import {
  EXECUTION_TIMEOUT,
  type CompletionCandidate,
  type CompletionDegradedReason,
  type Provider,
} from "./user-shell-runtime"

export const provider = Effect.gen(function* () {
  const process = yield* LocationProcess.Service
  const filesystem = yield* FileSystem.Service
  const location = yield* Location.Service
  return makeProvider(process, filesystem, location)
})

const controlPrefix = (nonce: string) => `\0opencode-cwd-${nonce}\0`

export function wrapExecution(command: string, nonce: string) {
  return `{ ${command}\n}; __opencode_status=$?; printf '\\000opencode-cwd-${nonce}\\000%s\\000' "$(pwd -P)"; exit "$__opencode_status"`
}

export function readExecutionControl(output: string, nonce: string) {
  const start = output.lastIndexOf(controlPrefix(nonce))
  if (start < 0) return { output }
  const value = start + controlPrefix(nonce).length
  const end = output.indexOf("\0", value)
  if (end < 0) return { output: output.slice(0, start) }
  const finalCwd = output.slice(value, end)
  return {
    output: output.slice(0, start) + output.slice(end + 1),
    ...(finalCwd ? { finalCwd } : {}),
  }
}

export function makeProvider(
  process: LocationProcess.Interface,
  filesystem: FileSystem.Interface,
  location: Location.Interface,
) {
  const execute: Provider["execute"] = (input) =>
    Effect.gen(function* () {
      const nonce = crypto.randomUUID().replaceAll("-", "")
      const result = yield* process.runShell(wrapExecution(input.command, nonce), {
        cwd: input.cwd,
        shell: "/bin/sh",
        env: input.environment,
        timeout: EXECUTION_TIMEOUT,
        maxOutputBytes: 8 * 1024 * 1024,
        signal: input.signal,
      })
      const visible = readExecutionControl(result.output?.toString("utf8") ?? "", nonce)
      const control = readExecutionControl(result.stdout.toString("utf8"), nonce)
      if (visible.output) yield* input.onOutput?.(visible.output) ?? Effect.void
      return { exitCode: result.exitCode, finalCwd: control.finalCwd }
    })
  const validateDirectory: Provider["validateDirectory"] = (directory) =>
    filesystem.list({ path: RelativePath.make(path.posix.relative(location.directory, directory)) }).pipe(
      Effect.as(directory),
      Effect.catch(() => Effect.succeed(undefined)),
    )
  const complete: Provider["complete"] = (input) =>
    Effect.gen(function* () {
      const range = UserShellLocal.replacementRange(input.input, input.cursor)
      const token = input.input.slice(range.start, range.end).replace(/^['"]/, "")
      const base = token.includes("/") ? path.posix.dirname(token) : "."
      const prefix = token.includes("/") ? path.posix.basename(token) : token
      const entries = yield* filesystem
        .list({ path: RelativePath.make(path.posix.relative(location.directory, path.posix.resolve(input.cwd, base))) })
        .pipe(Effect.catch(() => Effect.succeed([])))
      const paths = entries
        .filter((entry) => path.posix.basename(entry.path).startsWith(prefix))
        .map(
          (entry): CompletionCandidate => ({
            value: UserShellLocal.encodeCompletionValue(
              (base === "." ? "" : `${base}/`) +
                path.posix.basename(entry.path) +
                (entry.type === "directory" ? "/" : ""),
            ),
            display: path.posix.basename(entry.path),
            replacement: range,
            kind: entry.type,
          }),
        )
      if (token.includes("/")) return { candidates: paths }
      const shell = input.environment.SHELL ?? "/bin/sh"
      const run = (command: string, selectedShell: string, timeout: Duration.Input) =>
        process.runShell(command, {
          cwd: input.cwd,
          shell: selectedShell,
          env: { ...input.environment, TERM: "dumb", BASH_ENV: "", ENV: "" },
          timeout,
          maxOutputBytes: 512 * 1024,
          signal: input.signal,
        })
      const fallback = yield* run(UserShellLocal.commandFallbackScript(token), "/bin/sh", Duration.millis(750)).pipe(
        Effect.catch(() => Effect.void),
      )
      const commands = fallback ? UserShellLocal.parseCommandFallback(fallback.stdout.toString("utf8"), range) : []
      const supported = Shell.name(shell) === "bash" || Shell.name(shell) === "zsh"
      const native = supported
        ? yield* run(
            UserShellLocal.completionCommand(shell, input.input, input.cursor),
            "/bin/sh",
            Duration.millis(1500),
          ).pipe(Effect.exit)
        : undefined
      const names =
        native && Exit.isSuccess(native)
          ? UserShellLocal.parseCompletionOutput(native.value.stdout.toString("utf8"), token, range)
          : []
      const degraded: CompletionDegradedReason | undefined = !supported
        ? "native_unavailable"
        : native && Exit.isFailure(native)
          ? String(native.cause).includes("Timed out")
            ? "native_timeout"
            : "native_failed"
          : native?.value.exitCode === 0
            ? undefined
            : "native_failed"
      const candidates = [
        ...new Map([...paths, ...commands, ...names].map((candidate) => [candidate.value, candidate])).values(),
      ].toSorted((a, b) => a.display.localeCompare(b.display)).slice(0, 8)
      return { candidates, ...(degraded ? { degraded: { reason: degraded } } : {}) }
    })
  return { execute, validateDirectory, complete } satisfies Provider
}

export * as UserShellLocation from "./user-shell-location"
