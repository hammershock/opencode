import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import { ChildProcess } from "effect/unstable/process"
import { Stream } from "effect"
import path from "path"
import { testEffect } from "../lib/effect"
import { UserShellLocal } from "@/session/user-shell-local"

const { effect: it } = testEffect(LayerNode.compile(LayerNode.group([FSUtil.node, CrossSpawnSpawner.node])))

describe("UserShellLocal", () => {
  it(
    "runs a fresh bare shell and reports final cwd outside output",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      const child = path.join(root, "child")
      yield* fs.makeDirectory(child)
      yield* fs.writeFileString(path.join(root, ".zshenv"), "export LEAKED_FROM_STARTUP=yes\n")
      const output: string[] = []
      const result = yield* UserShellLocal.provider("/bin/zsh", fs, spawner).execute({
        cwd: root,
        command: 'cd child; printf "%s" "${LEAKED_FROM_STARTUP:-clean}"',
        environment: { HOME: root },
        onOutput: (chunk) => Effect.sync(() => output.push(chunk)),
      })
      expect(result.exitCode).toBe(0)
      expect(result.finalCwd).toBe(yield* fs.realPath(child))
      expect(output.join("")).toBe("clean")
      expect(output.join("")).not.toContain("opencode-user-shell")
    }),
  )

  it(
    "returns structured path replacements for quoting and cursor-in-middle",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(path.join(root, "two words.txt"), "ok")
      const result = yield* UserShellLocal.provider("/bin/zsh", fs, spawner).complete({
        cwd: root,
        input: "cat two\\ wor tail",
        cursor: 12,
        environment: { HOME: root },
      })
      expect(result.candidates).toContainEqual({
        value: "two\\ words.txt",
        display: "two words.txt",
        replacement: { start: 4, end: 12 },
        kind: "file",
      })
    }),
  )

  it(
    "does not load shell startup files while completing",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(path.join(root, ".zshrc"), "alias hammer-complete='printf helper'\n")
      const local = UserShellLocal.provider("/bin/zsh", fs, spawner)
      const result = yield* local.complete({
        cwd: root,
        input: "hammer-c",
        cursor: 8,
        environment: { HOME: root, ZDOTDIR: root },
      })
      expect(result.candidates.map((candidate) => candidate.value)).not.toContain("hammer-complete")

      const bashEnv = path.join(root, "bash-env")
      yield* fs.writeFileString(bashEnv, "complete -W 'hammer-from-env' hammer\n")
      const bash = yield* UserShellLocal.provider("/bin/bash", fs, spawner).complete({
        cwd: root,
        input: "hammer ",
        cursor: 7,
        environment: { HOME: root, BASH_ENV: bashEnv },
      })
      expect(bash.candidates.map((candidate) => candidate.value)).not.toContain("hammer-from-env")
    }),
  )

  it(
    "returns PATH fallback with a structured reason when native completion is unavailable",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      const bin = path.join(root, "bin")
      yield* fs.makeDirectory(bin)
      yield* fs.writeWithDirs(path.join(bin, "hammer-tool"), "", 0o755)
      const result = yield* UserShellLocal.provider("/bin/sh", fs, spawner).complete({
        cwd: root,
        input: "hammer",
        cursor: 6,
        environment: { PATH: `${bin}${path.delimiter}/bin` },
      })
      expect(result.degraded).toEqual({ reason: "native_unavailable" })
      expect(result.candidates).toContainEqual({
        value: "hammer-tool",
        display: "hammer-tool",
        replacement: { start: 0, end: 6 },
        kind: "command",
      })
    }),
  )

  it(
    "supports bash -F, -W, and -A programmable completion",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      const script = `_git_fixture() { [[ $COMP_LINE == 'git --fo tail' && $COMP_POINT == 8 ]] && COMPREPLY=('--format=json'); }
complete -F _git_fixture git
${UserShellLocal.bashCompletion("git --fo tail", 8)}
complete -W 'alpha beta' words
${UserShellLocal.bashCompletion("words b", 7)}
complete -A directory dirs
${UserShellLocal.bashCompletion("dirs c", 6)}`
      yield* fs.makeDirectory(path.join(root, "child"))
      const text = yield* runScript("/bin/bash", script, root, spawner)
      const candidates = UserShellLocal.parseCompletionOutput(text, "--fo", { start: 4, end: 8 })
      expect(candidates).toContainEqual({
        value: "--format=json",
        display: "--format=json",
        replacement: { start: 4, end: 8 },
        kind: "option",
      })
      expect(text).toContain("__OPENCODE_NATIVE__\tbeta")
      expect(text).toContain("__OPENCODE_NATIVE__\tchild")
    }),
  )

  it(
    "supports bash -C programmable completion",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      const script = `_external_fixture() { printf '%s\\n' command-choice; }
complete -C _external_fixture external
${UserShellLocal.bashCompletion("external c", 10)}`
      const text = yield* runScript("/bin/bash", script, root, spawner)
      expect(text).toContain("__OPENCODE_NATIVE__\tcommand-choice")
    }),
  )

  it(
    "invokes zsh compdef completion in a bare helper",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      const script = `autoload -Uz compinit; compinit -C -d /dev/null
_git_fixture() { compadd -- 'two words' '--verbose'; }
compdef _git_fixture git
${UserShellLocal.zshCompletion("git 'two w' tail", 10)}`
      const text = yield* runScript("/bin/zsh", script, root, spawner)
      const candidates = UserShellLocal.parseCompletionOutput(text, "two w", { start: 4, end: 11 })
      expect(candidates).toContainEqual({
        value: "two\\ words",
        display: "two words",
        replacement: { start: 4, end: 11 },
        kind: "argument",
      })
    }),
  )
})

function runScript(
  shell: string,
  script: string,
  cwd: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  return Effect.gen(function* () {
    const handle = yield* spawner.spawn(
      ChildProcess.make(shell, UserShellLocal.bareArgs(shell, script), {
        cwd,
        stdin: "ignore",
        stderr: "inherit",
      }),
    )
    const text = yield* Stream.decodeText(handle.stdout).pipe(Stream.mkString)
    expect(Number(yield* handle.exitCode)).toBe(0)
    return text
  }).pipe(Effect.scoped)
}
