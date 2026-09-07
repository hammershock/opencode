import path from "node:path"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { LocationProcess } from "@opencode-ai/core/location-process"
import { Location } from "@opencode-ai/core/location"
import { RelativePath } from "@opencode-ai/core/schema"
import { Duration, Effect } from "effect"
import { Shell } from "@opencode-ai/core/shell"
import { UserShellLocal } from "./user-shell-local"
import type { CompletionCandidate, Provider } from "./user-shell-runtime"

export const provider = Effect.gen(function* () {
  const process = yield* LocationProcess.Service
  const filesystem = yield* FileSystem.Service
  const location = yield* Location.Service
  return makeProvider(process, filesystem, location)
})

export function makeProvider(
  process: LocationProcess.Interface,
  filesystem: FileSystem.Interface,
  location: Location.Interface,
) {
  const execute: Provider["execute"] = (input) =>
    Effect.gen(function* () {
      const result = yield* process.runShell(input.command, {
        cwd: input.cwd,
        shell: "/bin/sh",
        env: input.environment,
        timeout: Duration.minutes(10),
        maxOutputBytes: 8 * 1024 * 1024,
        signal: input.signal,
      })
      if (result.output?.length) yield* input.onOutput?.(result.output.toString("utf8")) ?? Effect.void
      return { exitCode: result.exitCode }
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
      if (token.includes("/")) return paths
      const shell = input.environment.SHELL ?? "/bin/sh"
      if (Shell.name(shell) !== "bash" && Shell.name(shell) !== "zsh") return paths
      const result = yield* process
        .runShell(UserShellLocal.completionCommand(shell, input.input, input.cursor), {
          cwd: input.cwd,
          shell: "/bin/sh",
          env: { ...input.environment, TERM: "dumb" },
          timeout: Duration.millis(1500),
          maxOutputBytes: 512 * 1024,
          signal: input.signal,
        })
        .pipe(Effect.catch(() => Effect.void))
      const names = result ? UserShellLocal.parseCompletionOutput(result.stdout.toString("utf8"), token, range) : []
      return [...new Map([...paths, ...names].map((candidate) => [candidate.value, candidate])).values()].toSorted(
        (a, b) => a.display.localeCompare(b.display),
      )
    })
  return { execute, validateDirectory, complete } satisfies Provider
}

export * as UserShellLocation from "./user-shell-location"
