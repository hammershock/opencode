import { Duration, Effect, Option, Stream } from "effect"
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
    const names = yield* nameCandidates(
      shell,
      input.input,
      input.cursor,
      token,
      range,
      input.cwd,
      input.environment,
      spawner,
    )
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

export function encodeCompletionValue(value: string) {
  return /[\s'"\\]/.test(value) ? value.replaceAll(/([\s'"\\])/g, "\\$1") : value
}

function item(value: string, range: { start: number; end: number }, kind: CompletionKind): CompletionCandidate {
  return { value: encodeCompletionValue(value), display: value, replacement: range, kind }
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
  input: string,
  cursor: number,
  token: string,
  range: { start: number; end: number },
  cwd: string,
  environment: Environment,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  if (token.includes("/")) return Effect.succeed([])
  const name = Shell.name(shell)
  const script = completionScript(shell, input, cursor)
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
    return parseCompletionOutput(text, token, range)
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(1500)),
    Effect.map(Option.getOrElse(() => [])),
    Effect.catch(() => Effect.succeed([])),
  )
}

export function completionScript(shell: string, input: string, cursor: number) {
  const name = Shell.name(shell)
  const discovery =
    name === "zsh"
      ? `print -r -- __OPENCODE_ALIAS__; print -rl -- \${(k)aliases}; print -r -- __OPENCODE_FUNCTION__; print -rl -- \${(k)functions}; print -r -- __OPENCODE_COMMAND__; print -rl -- \${(k)commands}`
      : name === "bash"
        ? `printf '%s\\n' __OPENCODE_ALIAS__; compgen -A alias; printf '%s\\n' __OPENCODE_FUNCTION__; compgen -A function; printf '%s\\n' __OPENCODE_COMMAND__; compgen -A command`
        : `printf '%s\\n' __OPENCODE_COMMAND__; command -v -a 2>/dev/null`
  const native = name === "bash" ? bashCompletion(input, cursor) : name === "zsh" ? zshCompletion(input, cursor) : ""
  return `${discovery}; ${native}`
}

export function completionCommand(shell: string, input: string, cursor: number) {
  const mode = Shell.name(shell) === "bash" || Shell.name(shell) === "zsh" ? "-ic" : "-c"
  return `${quote(shell)} ${mode} ${quote(completionScript(shell, input, cursor))}`
}

export function parseCompletionOutput(text: string, token: string, range: { start: number; end: number }) {
  let kind: CompletionKind = "command"
  return text.split(/\r?\n/).flatMap((candidate) => {
    if (candidate.startsWith("__OPENCODE_NATIVE__\t"))
      return [nativeItem(candidate.slice("__OPENCODE_NATIVE__\t".length), range)]
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
}

function bashCompletion(input: string, cursor: number) {
  const line = quote(input)
  return `
COMP_LINE=${line}; COMP_POINT=${cursor};
read -r -a COMP_WORDS <<< "\${COMP_LINE:0:COMP_POINT}";
[[ "\${COMP_LINE:COMP_POINT-1:1}" == " " ]] && COMP_WORDS+=("");
COMP_CWORD=$((${"#"}COMP_WORDS[@]-1));
_completion_loader "\${COMP_WORDS[0]}" >/dev/null 2>&1 || true;
__opencode_spec=$(complete -p -- "\${COMP_WORDS[0]}" 2>/dev/null) || true;
if [[ $__opencode_spec =~ '-F '([^[:space:]]+) ]]; then
  __opencode_fn="\${BASH_REMATCH[1]}";
  "$__opencode_fn" "\${COMP_WORDS[0]}" "\${COMP_WORDS[COMP_CWORD]}" "\${COMP_WORDS[COMP_CWORD-1]}" >/dev/null 2>&1 || true;
  printf '__OPENCODE_NATIVE__\\t%s\\n' "\${COMPREPLY[@]}";
fi`
}

function zshCompletion(input: string, cursor: number) {
  const before = input.slice(0, cursor)
  const parsed = shellWords(before)
  const words = parsed.map(quote).join(" ")
  const current = parsed.length + (/\s$/.test(before) ? 1 : 0)
  const command = quote(parsed[0] ?? "")
  return `
if (( ! $+functions[compdef] )); then autoload -Uz compinit; compinit -d "\${TMPDIR:-/tmp}/opencode-zcompdump-$UID" >/dev/null 2>&1; fi;
words=(${words}); ${/\s$/.test(before) ? 'words+=("")' : ""} CURRENT=${Math.max(1, current)};
PREFIX=\${words[CURRENT]}; SUFFIX='';
function compadd { local seen=0 arg; for arg in "$@"; do [[ "$arg" == -- ]] && { seen=1; continue; }; (( seen )) && printf '__OPENCODE_NATIVE__\\t%s\\n' "$arg"; done; };
__opencode_command=${command}; __opencode_completion="\${_comps[$__opencode_command]}";
[[ -n "$__opencode_completion" ]] && "$__opencode_completion" 2>/dev/null || true`
}

function shellWords(input: string) {
  const words: string[] = []
  let word = ""
  let quote: "'" | '"' | undefined
  let escaped = false
  for (const char of input) {
    if (escaped) {
      word += char
      escaped = false
      continue
    }
    if (char === "\\" && quote !== "'") {
      escaped = true
      continue
    }
    if (char === "'" || char === '"') {
      if (!quote) quote = char
      else if (quote === char) quote = undefined
      else word += char
      continue
    }
    if (/\s/.test(char) && !quote) {
      if (word) words.push(word)
      word = ""
      continue
    }
    word += char
  }
  if (escaped) word += "\\"
  if (word || quote) words.push(word)
  return words
}

function unique(candidates: ReadonlyArray<CompletionCandidate>) {
  return [...new Map(candidates.map((candidate) => [candidate.value, candidate])).values()].toSorted((a, b) =>
    a.display.localeCompare(b.display),
  )
}

function nativeItem(record: string, range: { start: number; end: number }): CompletionCandidate {
  const [value, description] = record.split("\t", 2)
  return {
    ...item(value, range, value.startsWith("-") ? "option" : "argument"),
    ...(description ? { description } : {}),
  }
}
