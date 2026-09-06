import { describe, expect, test } from "bun:test"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { Location } from "@opencode-ai/core/location"
import type { LocationProcess } from "@opencode-ai/core/location-process"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Effect } from "effect"
import type { RexdLease } from "../../src/rexd/connection"
import { RexdFiles } from "../../src/rexd/location-files"
import { remoteGrep } from "../../src/rexd/location-filesystem"
import { runRexdProcess } from "../../src/rexd/location-process"
import { probeTarget } from "../../src/rexd/target-registry"
import { makeProvider as makeUserShellProvider } from "../../src/session/user-shell-location"

type Notify = (method: string, params: unknown) => void

function processLease(handler?: (method: string, params: Record<string, unknown>, emit: Notify) => unknown) {
  let notify: Notify = () => undefined
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
  return { lease, calls }
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

  test("user shell delegates execution and completion to location services", async () => {
    const executed: string[] = []
    const process = {
      runShell: (command: string) =>
        Effect.sync(() => {
          executed.push(command)
          return {
            command,
            exitCode: 0,
            output: Buffer.from("remote-shell"),
            stdout: Buffer.from("remote-shell"),
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
        environment: {},
        signal: new AbortController().signal,
        onOutput: (value) => Effect.sync(() => void output.push(value)),
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(executed).toEqual(["pwd"])
    expect(output).toEqual(["remote-shell"])
    const completion = await Effect.runPromise(
      shell.complete({ input: "rem", cursor: 3, cwd: "/workspace", environment: {} }),
    )
    expect(completion.map((item) => item.value)).toEqual(["remote.txt", "remote-dir/"])
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
  })
})
