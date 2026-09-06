import { describe, expect } from "bun:test"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Effect } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
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
      expect(result).toContainEqual({
        value: "two\\ words.txt",
        display: "two words.txt",
        replacement: { start: 4, end: 12 },
        kind: "file",
      })
    }),
  )

  it(
    "loads aliases only in the isolated completion helper",
    Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped()
      yield* fs.writeFileString(path.join(root, ".zshrc"), "alias hammer-complete='printf helper'\n")
      const local = UserShellLocal.provider("/bin/zsh", fs, spawner)
      const candidates = yield* local.complete({
        cwd: root,
        input: "hammer-c",
        cursor: 8,
        environment: { HOME: root, ZDOTDIR: root },
      })
      expect(candidates).toContainEqual({
        value: "hammer-complete",
        display: "hammer-complete",
        replacement: { start: 0, end: 8 },
        kind: "alias",
      })

      const output: string[] = []
      yield* local.execute({
        cwd: root,
        command: "alias hammer-complete >/dev/null 2>&1; printf $?",
        environment: { HOME: root, ZDOTDIR: root },
        onOutput: (chunk) => Effect.sync(() => output.push(chunk)),
      })
      expect(output.join("")).not.toBe("0")
    }),
  )
})
