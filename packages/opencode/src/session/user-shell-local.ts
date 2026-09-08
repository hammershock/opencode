import { Duration, Effect, Exit, Option, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import path from "path"
import { Shell } from "@opencode-ai/core/shell"
import { FSUtil } from "@opencode-ai/core/fs-util"
import type {
  CompletionCandidate,
  CompletionKind,
  CompletionProviderResult,
  Environment,
  Provider,
} from "./user-shell-runtime"

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
        env: { ...input.environment, TERM: "dumb", BASH_ENV: "", ENV: "" },
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
    const commands =
      token.includes("/") || !isCommandPosition(input.input, range.start)
        ? []
        : yield* commandCandidates(token, range, input.environment, fs)
    const native = yield* nativeCandidates(
      shell,
      input.input,
      input.cursor,
      token,
      range,
      input.cwd,
      input.environment,
      spawner,
    )
    return {
      candidates: unique([...paths, ...commands, ...native.candidates]),
      ...(native.degraded ? { degraded: native.degraded } : {}),
    }
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

export function isCommandPosition(input: string, cursor: number) {
  const safe = Math.max(0, Math.min(cursor, input.length))
  let quote: "'" | '"' | undefined
  let escaped = false
  let word = ""
  let expecting = true
  const commit = () => {
    if (!word) return
    if (!expecting || !/^[A-Za-z_][A-Za-z0-9_]*=.*/s.test(word)) expecting = false
    word = ""
  }
  for (let index = 0; index < safe; index++) {
    const char = input[index]!
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
      quote = quote === char ? undefined : (quote ?? char)
      continue
    }
    if (quote) {
      word += char
      continue
    }
    if (/\s/.test(char)) {
      commit()
      if (char === "\n") expecting = true
      continue
    }
    if (char === ";" || char === "|" || char === "&" || char === "(") {
      commit()
      expecting = true
      continue
    }
    word += char
  }
  commit()
  return expecting
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

export function commandFallbackScript(prefix: string) {
  return `__opencode_prefix=${quote(prefix)}; __opencode_old_ifs=$IFS; IFS=:; for __opencode_dir in $PATH; do IFS=$__opencode_old_ifs; for __opencode_path in "$__opencode_dir"/"$__opencode_prefix"*; do [ -f "$__opencode_path" ] && [ -x "$__opencode_path" ] && printf '__OPENCODE_COMMAND__\\t%s\\n' "\${__opencode_path##*/}"; done; IFS=:; done; IFS=$__opencode_old_ifs`
}

export function parseCommandFallback(text: string, range: { start: number; end: number }) {
  return text
    .split(/\r?\n/)
    .flatMap((line) =>
      line.startsWith("__OPENCODE_COMMAND__\t")
        ? [item(line.slice("__OPENCODE_COMMAND__\t".length), range, "command")]
        : [],
    )
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

function commandCandidates(
  token: string,
  range: { start: number; end: number },
  environment: Environment,
  fs: FSUtil.Interface,
) {
  const directories = (environment.PATH ?? "").split(path.delimiter).filter(Boolean)
  return Effect.all(
    directories.map((directory) =>
      fs.readDirectory(directory).pipe(
        Effect.flatMap((entries) =>
          Effect.all(
            entries
              .filter((entry) => entry.startsWith(token))
              .map((entry) =>
                fs.stat(path.join(directory, entry)).pipe(
                  Effect.map((info) =>
                    info.type === "File" && (process.platform === "win32" || (info.mode & 0o111) !== 0)
                      ? item(entry, range, "command")
                      : undefined,
                  ),
                  Effect.catch(() => Effect.void),
                ),
              ),
            { concurrency: "unbounded" },
          ).pipe(Effect.map((items) => items.filter((entry) => entry !== undefined))),
        ),
        Effect.catch(() => Effect.succeed([])),
      ),
    ),
    { concurrency: "unbounded" },
  ).pipe(Effect.map((groups) => unique(groups.flat())))
}

function nativeCandidates(
  shell: string,
  input: string,
  cursor: number,
  token: string,
  range: { start: number; end: number },
  cwd: string,
  environment: Environment,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): Effect.Effect<CompletionProviderResult> {
  if (token.includes("/")) return Effect.succeed({ candidates: [] })
  const name = Shell.name(shell)
  if (name !== "bash" && name !== "zsh")
    return Effect.succeed({ candidates: [], degraded: { reason: "native_unavailable" } })
  const script = completionScript(shell, input, cursor)
  const command = ChildProcess.make(shell, bareArgs(shell, script), {
    cwd,
    extendEnv: true,
    env: { ...environment, TERM: "dumb", BASH_ENV: "", ENV: "" },
    stdin: "ignore",
    stderr: "ignore",
    forceKillAfter: Duration.millis(250),
  })
  return Effect.gen(function* () {
    const handle = yield* spawner.spawn(command)
    const text = yield* Stream.decodeText(handle.stdout).pipe(Stream.mkString)
    const exitCode = yield* handle.exitCode
    if (exitCode !== 0)
      return { candidates: [], degraded: { reason: "native_failed" as const } } satisfies CompletionProviderResult
    return { candidates: parseCompletionOutput(text, token, range) } satisfies CompletionProviderResult
  }).pipe(
    Effect.scoped,
    Effect.timeoutOption(Duration.millis(1500)),
    Effect.map(
      Option.getOrElse(
        () => ({ candidates: [], degraded: { reason: "native_timeout" as const } }) satisfies CompletionProviderResult,
      ),
    ),
    Effect.exit,
    Effect.map((exit) =>
      Exit.isSuccess(exit)
        ? exit.value
        : ({ candidates: [], degraded: { reason: "native_failed" } } satisfies CompletionProviderResult),
    ),
  )
}

export function completionScript(shell: string, input: string, cursor: number) {
  const name = Shell.name(shell)
  const native = name === "bash" ? bashCompletion(input, cursor) : name === "zsh" ? zshCompletion(input, cursor) : ""
  return native
}

export function completionCommand(shell: string, input: string, cursor: number) {
  return bareCommand(shell, completionScript(shell, input, cursor))
}

export function bareCommand(shell: string, command: string) {
  return [quote(shell), ...bareArgs(shell, command).map(quote)].join(" ")
}

export function parseCompletionOutput(text: string, token: string, range: { start: number; end: number }) {
  let kind: CompletionKind = "command"
  return text.split(/\r?\n/).flatMap((candidate) => {
    if (!candidate) return []
    if (candidate.startsWith("__OPENCODE_NATIVE__\t"))
      return candidate.length === "__OPENCODE_NATIVE__\t".length || candidate.startsWith("__OPENCODE_NATIVE__\t\t")
        ? []
        : [nativeItem(candidate.slice("__OPENCODE_NATIVE__\t".length), range)]
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

export function bashCompletion(input: string, cursor: number) {
  const line = quote(input)
  return `
COMP_LINE=${line}; COMP_POINT=${cursor};
COMPREPLY=();
read -r -a COMP_WORDS <<< "\${COMP_LINE:0:COMP_POINT}";
[[ "\${COMP_LINE:COMP_POINT-1:1}" == " " ]] && COMP_WORDS+=("");
COMP_CWORD=$((\${#COMP_WORDS[@]}-1));
for __opencode_file in /opt/homebrew/etc/profile.d/bash_completion.sh /usr/local/share/bash-completion/bash_completion /usr/share/bash-completion/bash_completion; do
  [[ -r "$__opencode_file" ]] && { source "$__opencode_file" >/dev/null 2>&1 || true; break; };
done;
_completion_loader "\${COMP_WORDS[0]}" >/dev/null 2>&1 || true;
__opencode_spec=$(complete -p -- "\${COMP_WORDS[0]}" 2>/dev/null) || true;
if [[ -n "$__opencode_spec" ]]; then
  eval "set -- $__opencode_spec"; shift;
  while (( $# )); do
    case "$1" in
      -F) shift; "$1" "\${COMP_WORDS[0]}" "\${COMP_WORDS[COMP_CWORD]}" "\${COMP_WORDS[COMP_CWORD-1]}" >/dev/null 2>&1 || true ;;
      -W) shift; while IFS= read -r __opencode_item; do COMPREPLY+=("$__opencode_item"); done < <(compgen -W "$1" -- "\${COMP_WORDS[COMP_CWORD]}") ;;
      -C) shift; while IFS= read -r __opencode_item; do COMPREPLY+=("$__opencode_item"); done < <(COMP_LINE="$COMP_LINE" COMP_POINT="$COMP_POINT" COMP_TYPE=9 COMP_KEY=9 eval "$1") ;;
      -A) shift; while IFS= read -r __opencode_item; do COMPREPLY+=("$__opencode_item"); done < <(compgen -A "$1" -- "\${COMP_WORDS[COMP_CWORD]}") ;;
      -a|-b|-c|-d|-e|-f|-g|-j|-k|-s|-u|-v) while IFS= read -r __opencode_item; do COMPREPLY+=("$__opencode_item"); done < <(compgen "$1" -- "\${COMP_WORDS[COMP_CWORD]}") ;;
    esac;
    shift;
  done;
  printf '__OPENCODE_NATIVE__\\t%s\\n' "\${COMPREPLY[@]}";
fi`
}

export function zshCompletion(input: string, cursor: number) {
  const before = input.slice(0, cursor)
  const parsed = shellWords(before)
  const words = parsed.map(quote).join(" ")
  const current = parsed.length + (/\s$/.test(before) ? 1 : 0)
  const command = quote(parsed[0] ?? "")
  return `
if (( ! $+functions[compdef] )); then autoload -Uz compinit; compinit -C -d /dev/null >/dev/null 2>&1; fi;
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
