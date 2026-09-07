import { describe, expect, test } from "bun:test"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import type { LocationProcess } from "@opencode-ai/core/location-process"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Duration, Effect } from "effect"
import { Context, Layer } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import type { RexdLease } from "../../src/rexd/connection"
import { RexdFiles } from "../../src/rexd/location-files"
import { remoteGrep } from "../../src/rexd/location-filesystem"
import { rexdFilesystemNodes } from "../../src/rexd/location-filesystem"
import { rexdSessionNode, RexdLocationSession } from "../../src/rexd/location-session"
import { runRexdProcess } from "../../src/rexd/location-process"
import { probeTarget } from "../../src/rexd/target-registry"
import {
  makeProvider as makeUserShellProvider,
  readExecutionControl,
  targetShell,
  wrapExecution,
} from "../../src/session/user-shell-location"
import { EXECUTION_TIMEOUT } from "../../src/session/user-shell-runtime"
import { AppProcess } from "@opencode-ai/core/process"

type Notify = (method: string, params: unknown) => void

function processLease(handler?: (method: string, params: Record<string, unknown>, emit: Notify) => unknown) {
  let notify: Notify = () => undefined
  let close: (error: Error) => void = () => undefined
  const calls: Array<{ method: string; params: Record<string, unknown> }> = []
  const lease = {
    handshake: { sessionID: "remote-session", workspaceRoots: ["/workspace"] },
    client: {
      onNotification(listener: Notify) {
        notify = listener
        return () => {
          notify = () => undefined
        }
      },
      onClose(listener: (error: Error) => void) {
        close = listener
        return () => {
          close = () => undefined
        }
      },
      async request(method: string, params: Record<string, unknown>) {
        calls.push({ method, params })
        const custom = handler?.(method, params, notify)
        if (custom !== undefined) return custom
        if (method === "exec.start") {
          queueMicrotask(() => {
            notify("exec.stdout", { process_id: "process-1", data: "remote-output" })
            notify("exec.exit", { process_id: "process-1", exit_code: 0 })
          })
          return { process_id: "process-1" }
        }
        if (method === "exec.kill") return { ok: true }
        throw new Error(`unexpected RPC ${method}`)
      },
    },
  } as unknown as RexdLease
  return { lease, calls, disconnect: (error = new Error("ssh disconnected")) => close(error) }
}

describe("Rexd Location routing contract", () => {
  const targetID = Location.TargetID.make("00000000-0000-4000-8000-000000000001")
  test("process and formatter-style argv execution remain remote and shell-free", async () => {
    const { lease, calls } = processLease()
    const result = await runRexdProcess(lease, {
      argv: ["prettier", "--write", "file.ts"],
      shell: false,
      cwd: "/workspace",
      env: { REMOTE_ONLY: "1" },
      timeout: "10 seconds",
      maxOutputBytes: 1024,
    })

    expect(result.stdout.toString()).toBe("remote-output")
    expect(calls[0]).toMatchObject({
      method: "exec.start",
      params: { argv: ["prettier", "--write", "file.ts"], shell: false, cwd: "/workspace" },
    })
  })

  test("disconnect fails instead of executing on the controller", async () => {
    const marker = `/tmp/opencode-location-fallback-${crypto.randomUUID()}`
    const { lease } = processLease(() => {
      throw new Error("ssh disconnected")
    })
    await expect(
      runRexdProcess(lease, {
        command: `touch ${marker}`,
        shell: true,
        cwd: "/workspace",
        timeout: "10 seconds",
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow("ssh disconnected")
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("transport loss after process start fails the operation without retry", async () => {
    const { lease, calls, disconnect } = processLease((method) => {
      if (method === "exec.start") return { process_id: "running" }
      if (method === "exec.kill") return { ok: true }
      return undefined
    })
    const running = runRexdProcess(lease, {
      command: "touch remote-only",
      shell: true,
      cwd: "/workspace",
      timeout: "10 seconds",
      maxOutputBytes: 1024,
    })
    await Promise.resolve()
    disconnect()
    await expect(running).rejects.toThrow("ssh disconnected")
    expect(calls.filter((call) => call.method === "exec.start")).toHaveLength(1)
  })

  test("failed process start releases all listeners", async () => {
    let notifications = 0
    let closes = 0
    const lease = {
      handshake: { sessionID: "remote-session", workspaceRoots: ["/workspace"] },
      client: {
        onNotification() {
          notifications++
          return () => notifications--
        },
        onClose() {
          closes++
          return () => closes--
        },
        async request() {
          throw new Error("start rejected")
        },
      },
    } as unknown as RexdLease
    await expect(
      runRexdProcess(lease, {
        command: "false",
        shell: true,
        cwd: "/workspace",
        timeout: "10 seconds",
        maxOutputBytes: 1024,
      }),
    ).rejects.toThrow("start rejected")
    expect({ notifications, closes }).toEqual({ notifications: 0, closes: 0 })
  })

  test("cancelled process is killed remotely and releases its notification listener", async () => {
    let removed = false
    let notify: Notify = () => undefined
    const calls: string[] = []
    const lease = {
      handshake: { sessionID: "remote-session", workspaceRoots: ["/workspace"] },
      client: {
        onNotification(value: Notify) {
          notify = value
          return () => {
            removed = true
          }
        },
        onClose() {
          return () => undefined
        },
        async request(method: string) {
          calls.push(method)
          if (method === "exec.start") return { process_id: "slow" }
          if (method === "exec.kill") return { ok: true }
          throw new Error(`unexpected RPC ${method}`)
        },
      },
    } as unknown as RexdLease
    const controller = new AbortController()
    const running = runRexdProcess(lease, {
      command: "sleep 100",
      shell: true,
      cwd: "/workspace",
      timeout: "2 minutes",
      maxOutputBytes: 1024,
      signal: controller.signal,
    })
    await Promise.resolve()
    controller.abort(new Error("cancelled"))
    await expect(running).rejects.toThrow("cancelled")
    expect(calls).toContain("exec.kill")
    expect(removed).toBe(true)
    notify("exec.exit", { process_id: "slow", exit_code: 0 })
  })

  test("grep uses one explicit remote argv and never downloads the workspace", async () => {
    const { lease, calls } = processLease((method, _params, emit) => {
      if (method === "fs.stat") return { path: "/workspace", exists: true, type: "dir", mtime: 1 }
      if (method === "exec.start") {
        queueMicrotask(() => {
          emit("exec.stdout", { process_id: "grep-1", data: "src/a.ts\u00002:needle\n" })
          emit("exec.exit", { process_id: "grep-1", exit_code: 0 })
        })
        return { process_id: "grep-1" }
      }
      return undefined
    })

    const matches = await Effect.runPromise(
      remoteGrep(new RexdFiles("gpu", lease), lease, "/workspace", {
        pattern: "needle",
        path: RelativePath.make("."),
      }),
    )
    expect(matches).toHaveLength(1)
    expect(String(matches[0]?.entry.path)).toBe("src/a.ts")
    expect(calls.some((call) => call.method === "fs.read")).toBe(false)
    expect(calls.find((call) => call.method === "exec.start")?.params).toMatchObject({ shell: false })
  })

  test("location FS boots and resolves a remote-only path without controller fallback", async () => {
    const remoteRoot = `/remote-only-${crypto.randomUUID()}`
    expect(await Bun.file(remoteRoot).exists()).toBe(false)
    const { lease, calls } = processLease((method, params) => {
      if (method === "fs.stat")
        return { path: params.path, exists: true, type: params.path === remoteRoot ? "dir" : "file", mtime: 1 }
      return undefined
    })
    lease.handshake.workspaceRoots = [remoteRoot]
    const ref = Location.Ref.make({ target: { type: "rexd", targetID }, directory: AbsolutePath.make(remoteRoot) })
    const session = rexdSessionNode(ref)
    const fsNode = rexdFilesystemNodes(session, targetID, remoteRoot)[2]
    const testLayer = LayerNode.compile(fsNode, [[session, Layer.succeed(RexdLocationSession, lease)]])
    const context = await Effect.runPromise(Effect.scoped(Layer.build(testLayer)))
    const fs = Context.get(context, FSUtil.Service)
    expect(await Effect.runPromise(fs.realPath(remoteRoot))).toBe(remoteRoot)
    expect(calls).toContainEqual({ method: "fs.stat", params: expect.objectContaining({ path: remoteRoot }) })
    expect(await Bun.file(remoteRoot).exists()).toBe(false)
  })

  test("user shell delegates execution and completion to location services", async () => {
    const executed: string[] = []
    let executionTimeout = 0
    let executionEnvironment: Readonly<Record<string, string>> | undefined
    const process = {
      runShell: (command: string, options: { timeout: Duration.Duration; env?: Readonly<Record<string, string>> }) =>
        Effect.sync(() => {
          executed.push(command)
          executionTimeout = Duration.toMillis(options.timeout)
          executionEnvironment = options.env
          const nonce = command.match(/opencode-cwd-([a-f0-9]+)/)?.[1]
          const output = nonce
            ? Buffer.from(`remote-shell\0opencode-cwd-${nonce}\0/workspace/child\0`)
            : Buffer.from("remote-shell")
          return {
            command,
            exitCode: 0,
            output,
            stdout: output,
            stderr: Buffer.alloc(0),
            outputTruncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }
        }),
    } as LocationProcess.Interface
    const filesystem = FileSystem.Service.of({
      list: () =>
        Effect.succeed([
          FileSystem.Entry.make({ path: RelativePath.make("remote.txt"), type: "file" }),
          FileSystem.Entry.make({ path: RelativePath.make("remote-dir/"), type: "directory" }),
        ]),
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
      grep: () => Effect.succeed([]),
      read: () => Effect.die("not used"),
      directoryStatus: () => Effect.die("not used"),
      ensureDirectory: () => Effect.die("not used"),
    })
    const location = Location.Service.of({
      target: { type: "rexd", targetID },
      directory: AbsolutePath.make("/workspace"),
      workspaceID: "workspace" as never,
      project: { id: "project" as never, directory: AbsolutePath.make("/workspace") },
    })
    const shell = makeUserShellProvider(process, filesystem, location)
    const output: string[] = []
    const result = await Effect.runPromise(
      shell.execute({
        command: "pwd",
        cwd: "/workspace",
        environment: { SHELL: "/bin/zsh", BASH_ENV: "/target/.bash_env", ENV: "/target/.sh_env" },
        signal: new AbortController().signal,
        onOutput: (value) => Effect.sync(() => void output.push(value)),
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.finalCwd).toBe("/workspace/child")
    expect(executed).toHaveLength(1)
    expect(executed[0]).toStartWith("'/bin/zsh' '-f' '-c'")
    expect(executed[0]).toContain("{ pwd")
    expect(executionEnvironment).toMatchObject({ SHELL: "/bin/zsh", BASH_ENV: "", ENV: "" })
    expect(executed[0]).toContain("pwd -P")
    expect(executionTimeout).toBe(Duration.toMillis(EXECUTION_TIMEOUT))
    expect(output).toEqual(["remote-shell"])
    const completion = await Effect.runPromise(
      shell.complete({ input: "rem", cursor: 3, cwd: "/workspace", environment: {} }),
    )
    expect(completion.candidates.map((item) => item.value)).toEqual(["remote-dir/", "remote.txt"])
  })

  test("remote user shell control framing is nonce-bound and never enters visible output", () => {
    const nonce = "0123456789abcdef"
    const wrapped = wrapExecution("cd child; false", nonce)
    expect(wrapped).toContain("cd child; false")
    expect(wrapped).toContain(`opencode-cwd-${nonce}`)

    expect(readExecutionControl(`visible\0opencode-cwd-${nonce}\0/workspace/child\0`, nonce)).toEqual({
      output: "visible",
      finalCwd: "/workspace/child",
    })
    expect(readExecutionControl("visible\0opencode-cwd-fixed\0/controller\0", nonce)).toEqual({
      output: "visible\0opencode-cwd-fixed\0/controller\0",
    })
    expect(readExecutionControl(`visible\0opencode-cwd-${nonce}\0broken`, nonce)).toEqual({ output: "visible" })
  })

  test("remote user shell loads native completion on the target", async () => {
    const executed: string[] = []
    const process = {
      runShell: (command: string) =>
        Effect.sync(() => {
          executed.push(command)
          const output = Buffer.from("__OPENCODE_NATIVE__\t--format=json\n")
          return {
            command,
            exitCode: 0,
            output,
            stdout: output,
            stderr: Buffer.alloc(0),
            outputTruncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }
        }),
    } as LocationProcess.Interface
    const filesystem = FileSystem.Service.of({
      list: () => Effect.succeed([]),
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
      grep: () => Effect.succeed([]),
      read: () => Effect.die("not used"),
      directoryStatus: () => Effect.die("not used"),
      ensureDirectory: () => Effect.die("not used"),
    })
    const location = Location.Service.of({
      target: { type: "rexd", targetID },
      directory: AbsolutePath.make("/workspace"),
      workspaceID: "workspace" as never,
      project: { id: "project" as never, directory: AbsolutePath.make("/workspace") },
    })
    const shell = makeUserShellProvider(process, filesystem, location)
    const completion = await Effect.runPromise(
      shell.complete({
        input: "git --fo",
        cursor: 8,
        cwd: "/workspace",
        environment: { SHELL: "/bin/bash" },
      }),
    )
    expect(executed.some((command) => command.includes("/bin/bash"))).toBe(true)
    expect(completion.candidates).toContainEqual({
      value: "--format=json",
      display: "--format=json",
      replacement: { start: 4, end: 8 },
      kind: "option",
    })
  })

  test("remote user shell returns PATH fallback and a structured native timeout", async () => {
    const process = {
      runShell: (command: string) =>
        command.includes("__opencode_prefix")
          ? Effect.succeed({
              command,
              exitCode: 0,
              output: Buffer.alloc(0),
              stdout: Buffer.from("__OPENCODE_COMMAND__\thammer-tool\n"),
              stderr: Buffer.alloc(0),
              outputTruncated: false,
              stdoutTruncated: false,
              stderrTruncated: false,
            })
          : Effect.fail(new AppProcess.AppProcessError({ command, cause: new Error("Timed out") })),
    } as LocationProcess.Interface
    const filesystem = FileSystem.Service.of({
      list: () => Effect.succeed([]),
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
      grep: () => Effect.succeed([]),
      read: () => Effect.die("not used"),
      directoryStatus: () => Effect.die("not used"),
      ensureDirectory: () => Effect.die("not used"),
    })
    const location = Location.Service.of({
      target: { type: "rexd", targetID },
      directory: AbsolutePath.make("/workspace"),
      workspaceID: "workspace" as never,
      project: { id: "project" as never, directory: AbsolutePath.make("/workspace") },
    })
    const result = await Effect.runPromise(
      makeUserShellProvider(process, filesystem, location).complete({
        input: "hammer",
        cursor: 6,
        cwd: "/workspace",
        environment: { SHELL: "/bin/bash", PATH: "/usr/bin" },
      }),
    )
    expect(result.degraded).toEqual({ reason: "native_timeout" })
    expect(result.candidates.map((candidate) => candidate.value)).toEqual(["hammer-tool"])
  })

  test("remote user shell omits PATH command fallback for an argument", async () => {
    const executed: string[] = []
    const process = {
      runShell: (command: string) =>
        Effect.sync(() => {
          executed.push(command)
          return {
            command,
            exitCode: 0,
            output: Buffer.alloc(0),
            stdout: Buffer.from("__OPENCODE_COMMAND__\thammer-tool\n"),
            stderr: Buffer.alloc(0),
            outputTruncated: false,
            stdoutTruncated: false,
            stderrTruncated: false,
          }
        }),
    } as LocationProcess.Interface
    const filesystem = FileSystem.Service.of({
      list: () => Effect.succeed([FileSystem.Entry.make({ path: RelativePath.make("hammer-path"), type: "file" })]),
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
      grep: () => Effect.succeed([]),
      read: () => Effect.die("not used"),
      directoryStatus: () => Effect.die("not used"),
      ensureDirectory: () => Effect.die("not used"),
    })
    const location = Location.Service.of({
      target: { type: "rexd", targetID },
      directory: AbsolutePath.make("/workspace"),
      workspaceID: "workspace" as never,
      project: { id: "project" as never, directory: AbsolutePath.make("/workspace") },
    })
    const result = await Effect.runPromise(
      makeUserShellProvider(process, filesystem, location).complete({
        input: "git ham",
        cursor: 7,
        cwd: "/workspace",
        environment: { SHELL: "/bin/sh", PATH: "/usr/bin" },
      }),
    )
    expect(executed).toEqual([])
    expect(result.candidates.map((candidate) => candidate.value)).toEqual(["hammer-path"])
  })

  test("remote user shell keeps candidates beyond the eight-row TUI viewport", async () => {
    const process = {
      runShell: () => Effect.die("path argument completion must not spawn a shell"),
    } as LocationProcess.Interface
    const filesystem = FileSystem.Service.of({
      list: () =>
        Effect.succeed(
          Array.from({ length: 12 }, (_, index) =>
            FileSystem.Entry.make({
              path: RelativePath.make(`candidate-${String(index).padStart(2, "0")}`),
              type: "file",
            }),
          ),
        ),
      find: () => Effect.succeed([]),
      glob: () => Effect.succeed([]),
      grep: () => Effect.succeed([]),
      read: () => Effect.die("not used"),
      directoryStatus: () => Effect.die("not used"),
      ensureDirectory: () => Effect.die("not used"),
    })
    const location = Location.Service.of({
      target: { type: "rexd", targetID },
      directory: AbsolutePath.make("/workspace"),
      workspaceID: "workspace" as never,
      project: { id: "project" as never, directory: AbsolutePath.make("/workspace") },
    })
    const result = await Effect.runPromise(
      makeUserShellProvider(process, filesystem, location).complete({
        input: "cat ./candidate-",
        cursor: 16,
        cwd: "/workspace",
        environment: { SHELL: "/bin/bash" },
      }),
    )
    expect(result.candidates).toHaveLength(12)
    expect(result.candidates.at(8)?.value).toBe("candidate-08")
    expect(result.candidates.at(11)?.value).toBe("candidate-11")
  })

  test("remote user shell falls back from an unsupported target shell", () => {
    expect(targetShell({})).toBe("/bin/sh")
    expect(targetShell({ SHELL: "/usr/bin/fish" })).toBe("/bin/sh")
    expect(targetShell({ SHELL: "/bin/bash" })).toBe("/bin/bash")
  })

  test("target probe reports protocol stage without leaking a thrown failure", async () => {
    const target = {
      id: targetID,
      status: "unverified" as const,
      name: "GPU",
      transport: "ssh" as const,
      connection: { type: "ssh-config" as const, host: "gpu" },
      workspaceRoots: ["/workspace"],
      defaultDirectory: "/workspace",
    }
    const ready = await probeTarget(target, async () => ({ handshake: {}, prepared: undefined }) as never)
    expect(ready.status).toBe("ready")
    if (ready.status === "ready") expect(ready.stages).toContain("capabilities")

    let probedDirectory: string | undefined
    await probeTarget(
      target,
      async (_target, options) => {
        probedDirectory = options.directory
        return { handshake: {}, prepared: undefined } as never
      },
      true,
      "/workspace/historical",
    )
    expect(probedDirectory).toBe("/workspace/historical")
  })
})
