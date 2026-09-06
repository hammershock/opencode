import type { ChildProcessWithoutNullStreams } from "child_process"
import { Process } from "@/util/process"
import { AsyncLocalStorage } from "node:async_hooks"

const environment = new AsyncLocalStorage<Readonly<Record<string, string>>>()

export function withEnvironment<A>(env: Readonly<Record<string, string>>, run: () => Promise<A>) {
  return environment.run(env, run)
}

type Child = Process.Child & ChildProcessWithoutNullStreams

export function spawn(cmd: string, args: string[], opts?: Process.Options): Child
export function spawn(cmd: string, opts?: Process.Options): Child
export function spawn(cmd: string, argsOrOpts?: string[] | Process.Options, opts?: Process.Options) {
  const args = Array.isArray(argsOrOpts) ? [...argsOrOpts] : []
  const cfg = Array.isArray(argsOrOpts) ? opts : argsOrOpts
  const proc = Process.spawn([cmd, ...args], {
    ...cfg,
    env: { ...environment.getStore(), ...cfg?.env },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Child

  if (!proc.stdin || !proc.stdout || !proc.stderr) throw new Error("Process output not available")

  return proc
}
