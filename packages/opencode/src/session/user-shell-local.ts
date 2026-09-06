import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type { CompletionCandidate, CompletionKind, Environment, Provider } from "./user-shell-runtime"

export * as UserShellLocal from "./user-shell-local"

export function bareArgs(shell: string, command: string) {
  if (Shell.name(shell) === "bash") return ["--noprofile", "--norc", "-c", command]
  if (Shell.name(shell) === "zsh") return ["-f", "-c", command]
  if (Shell.name(shell) === "cmd") return ["/d", "/s", "/c", command]
  if (Shell.ps(shell)) return ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command]
  return ["-c", command]
}

export function provider(
  shell: string,
  fs: FSUtil.Interface,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Provider {
  const execute: Provider["execute"] = (input) =>
    Effect.gen(function* () {
      const controlDir = yield* fs.makeTempDirectoryScoped({ prefix: "opencode-user-shell-" })
      const control = path.join(controlDir, "cwd")
      const wrapped = wrap(input.command, control, shell)
      const process = ChildProcess.make(shell, bareArgs(shell, wrapped), {
        cwd: input.cwd,
        extendEnv: true,
        env: { ...input.environment, TERM: "dumb" },
        stdin: "ignore",
        forceKillAfter: "3 seconds",
      })
      const handle = yield* spawner.spawn(process)
      yield* Stream.runForEach(Stream.decodeText(handle.all), (chunk) => input.onOutput?.(chunk) ?? Effect.void)
      const exitCode = yield* handle.exitCode
      const finalCwd = yield* fs.readFileString(control).pipe(Effect.catch(() => Effect.void))
      return { exitCode, finalCwd: finalCwd?.trim() || undefined }
    }).pipe(Effect.scoped)

  const validateDirectory: Provider["validateDirectory"] = Effect.fn("UserShellLocal.validateDirectory")(
    function* (directory) {
      if (!path.isAbsolute(directory)) return
      const info = yield* fs.stat(directory).pipe(Effect.catch(() => Effect.void))
      if (info?.type !== "Directory") return
      return yield* fs.realPath(directory).pipe(Effect.catch(() => Effect.succeed(path.resolve(directory))))
    },
  )

  const complete: Provider["complete"] = Effect.fn("UserShellLocal.complete")(function* (input) {
    const range = replacementRange(input.input, input.cursor)
    const token = unquote(input.input.slice(range.start, range.end))
    const paths = yield* pathCandidates(input.cwd, token, range, fs)
    const names = yield* nameCandidates(shell, token, range, input.cwd, input.environment, spawner)
    return unique([...paths, ...names])
  })

  return { execute, validateDirectory, complete }
}

export function replacementRange(input: string, cursor: number) {
  const safe = Math.max(0, Math.min(cursor, input.length))
  let start = 0
  let quote: "'" | '"' | undefined
  let escaped = false
  for (let index = 0; index < safe; index++) {
    const char = input[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? undefined : (quote ?? char)
      continue
    }
    if (!quote && /\s/.test(char)) start = index + 1
  }
  let end = safe
  quote = undefined
  escaped = false
  for (let index = start; index < input.length; index++) {
    const char = input[index]
    if (escaped) {
      escaped = false
      end = index + 1
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      end = index + 1
      continue
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? undefined : (quote ?? char)
      end = index + 1
      continue
    }
    if (!quote && /\s/.test(char)) break
    end = index + 1
  }
  return { start, end }
}

function wrap(command: string, control: string, shell: string) {
  if (Shell.ps(shell)) {
    const file = control.replaceAll("'", "''")
    return `& { ${command} }; $opencodeStatus = if ($?) { 0 } else { 1 }; (Get-Location).Path | Set-Content -NoNewline -LiteralPath '${file}'; exit $opencodeStatus`
  }
  if (!Shell.posix(shell)) return command
  return `{ ${command}\n}; __opencode_status=$?; pwd -P > ${quote(control)}; exit $__opencode_status`
}

function quote(input: string) {
  return `'${input.replaceAll("'", `'"'"'`)}'`
}

function unquote(input: string) {
  if (input.startsWith("'") || input.startsWith('"')) return input.slice(1)
  return input.replaceAll(/\\(.)/g, "$1")
}

function encoded(value: string) {
  return /[\s'"\\]/.test(value) ? value.replaceAll(/([\s'"\\])/g, "\\$1") : value
}

function item(value: string, range: { start: number; end: number }, kind: CompletionKind): CompletionCandidate {
  return { value: encoded(value), display: value, replacement: range, kind }
}

function pathCandidates(cwd: string, token: string, range: { start: number; end: number }, fs: FSUtil.Interface) {
  const base = token.includes("/") ? path.dirname(token) : "."
  const prefix = token.includes("/") ? path.basename(token) : token
  const directory = path.resolve(cwd, base)
  return fs.readDirectory(directory).pipe(
    Effect.map((entries) =>
      entries
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => {
          const absolute = path.join(directory, entry)
          const relative = base === "." ? entry : path.join(base, entry)
          return fs.stat(absolute).pipe(
            Effect.map((info) =>
              item(
                info.type === "Directory" ? relative + "/" : relative,
                range,
                info.type === "Directory" ? "directory" : "file",
              ),
            ),
            Effect.catch(() => Effect.succeed(item(relative, range, "file"))),
          )
        }),
    ),
    Effect.flatMap(Effect.all),
    Effect.catch(() => Effect.succeed([])),
  )
}

function nameCandidates(
  shell: string,
  token: string,
  range: { start: number; end: number },
  cwd: string,
  environment: Environment,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  if (token.includes("/")) return Effect.succeed([])
  const name = Shell.name(shell)
  const script =
    name === "zsh"
      ? `print -r -- __OPENCODE_ALIAS__; print -rl -- \${(k)aliases}; print -r -- __OPENCODE_FUNCTION__; print -rl -- \${(k)functions}; print -r -- __OPENCODE_COMMAND__; print -rl -- \${(k)commands}`
      : name === "bash"
        ? `printf '%s\\n' __OPENCODE_ALIAS__; compgen -A alias; printf '%s\\n' __OPENCODE_FUNCTION__; compgen -A function; printf '%s\\n' __OPENCODE_COMMAND__; compgen -A command`
        : `printf '%s\\n' __OPENCODE_COMMAND__; command -v -a 2>/dev/null`
  const args = name === "zsh" || name === "bash" ? ["-ic", script] : ["-c", script]
  const command = ChildProcess.make(shell, args, {
    cwd,
    extendEnv: true,
    env: { ...environment, TERM: "dumb" },
    stdin: "ignore",
    stderr: "ignore",
    forceKillAfter: "3 seconds",
  })
  return Effect.gen(function* () {
    const handle = yield* spawner.spawn(command)
    const text = yield* Stream.decodeText(handle.stdout).pipe(Stream.mkString)
    yield* handle.exitCode
    let kind: CompletionKind = "command"
    return text.split(/\r?\n/).flatMap((candidate) => {
      if (candidate === "__OPENCODE_ALIAS__") {
        kind = "alias"
        return []
      }
      if (candidate === "__OPENCODE_FUNCTION__") {
        kind = "function"
        return []
      }
      if (candidate === "__OPENCODE_COMMAND__") {
        kind = "command"
        return []
      }
      return candidate.startsWith(token) ? [item(candidate, range, kind)] : []
    })
  }).pipe(
    Effect.scoped,
    Effect.catch(() => Effect.succeed([])),
  )
}

function unique(candidates: ReadonlyArray<CompletionCandidate>) {
  return [...new Map(candidates.map((candidate) => [candidate.value, candidate])).values()].toSorted((a, b) =>
    a.display.localeCompare(b.display),
  )
}
