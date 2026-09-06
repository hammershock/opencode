import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { cancelled, redactDiagnostic, RexdError } from "./error"

export type SshConnection =
  | { type: "ssh-config"; host: string }
  | { type: "manual"; host: string; user: string; port: number; identityFile?: string }

export type RexdTarget = {
  id: string
  connection: SshConnection
  workspaceRoots: readonly string[]
  command?: readonly string[]
}

export type Transport = {
  write(payload: string): Promise<void>
  onData(listener: (chunk: string) => void): () => void
  onClose(listener: (error: RexdError) => void): () => void
  close(): Promise<void>
}

export function sshArguments(connection: SshConnection, command: string) {
  return [
    ...(connection.type === "manual" ? ["-p", String(connection.port)] : []),
    ...(connection.type === "manual" && connection.identityFile ? ["-i", connection.identityFile] : []),
    "-o",
    "BatchMode=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-T",
    connection.type === "manual" ? `${connection.user}@${connection.host}` : connection.host,
    command,
  ]
}

export async function runSshScript(connection: SshConnection, script: string, signal?: AbortSignal, sshBinary = "ssh") {
  if (signal?.aborted) throw cancelled(signal)
  const child = spawn(sshBinary, sshArguments(connection, "sh -s"), { stdio: ["pipe", "pipe", "pipe"] })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk))
  const abort = () => child.kill("SIGTERM")
  signal?.addEventListener("abort", abort, { once: true })
  child.stdin.end(script)
  const result = await new Promise<{ code: number | null; spawnError?: Error }>((resolve) => {
    child.once("error", (spawnError) => resolve({ code: null, spawnError }))
    child.once("close", (code) => resolve({ code }))
  })
  signal?.removeEventListener("abort", abort)
  if (signal?.aborted) throw cancelled(signal)
  const output = Buffer.concat(stdout).toString("utf8")
  const detail = redactDiagnostic(Buffer.concat(stderr).toString("utf8"), connectionSecrets(connection))
  if (result.spawnError) throw new RexdError("ssh", "Could not start SSH", true, "failed", result.spawnError.name)
  if (result.code !== 0) throw classifySshFailure(result.code, detail)
  return { stdout: output, stderr: detail }
}

export function connectSsh(connection: SshConnection, command: string, sshBinary = "ssh"): Transport {
  return new SshTransport(
    spawn(sshBinary, sshArguments(connection, command), { stdio: ["pipe", "pipe", "pipe"] }),
    connection,
  )
}

export class SshTransport implements Transport {
  readonly #data = new Set<(chunk: string) => void>()
  readonly #close = new Set<(error: RexdError) => void>()
  readonly #stderr: string[] = []
  #closed = false

  constructor(
    readonly child: ChildProcessWithoutNullStreams,
    readonly connection: SshConnection,
  ) {
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => this.#data.forEach((listener) => listener(chunk)))
    child.stderr.on("data", (chunk: string) => {
      this.#stderr.push(chunk)
      if (this.#stderr.join("").length > 16 * 1024) this.#stderr.splice(0, 1)
    })
    child.once("error", (error) =>
      this.#finish(new RexdError("ssh", "SSH transport failed", true, "unknown", error.name)),
    )
    child.once("close", (code, signal) => {
      const detail = redactDiagnostic(this.#stderr.join(""), connectionSecrets(connection))
      this.#finish(
        new RexdError("transport", `Remote transport closed (${code ?? signal ?? "unknown"})`, true, "unknown", detail),
      )
    })
  }

  write(payload: string) {
    if (this.#closed) return Promise.reject(new RexdError("transport", "Remote transport is closed", true, "unknown"))
    return new Promise<void>((resolve, reject) => {
      this.child.stdin.write(payload, (error) => {
        if (error) return reject(new RexdError("transport", "Could not write to remote transport", true, "unknown"))
        resolve()
      })
    })
  }

  onData(listener: (chunk: string) => void) {
    this.#data.add(listener)
    return () => this.#data.delete(listener)
  }

  onClose(listener: (error: RexdError) => void) {
    this.#close.add(listener)
    return () => this.#close.delete(listener)
  }

  async close() {
    if (this.#closed) return
    this.#closed = true
    this.#data.clear()
    this.#close.clear()
    this.child.stdin.end()
    if (this.child.exitCode === null && !this.child.killed) this.child.kill("SIGTERM")
  }

  #finish(error: RexdError) {
    if (this.#closed) return
    this.#closed = true
    this.#close.forEach((listener) => listener(error))
    this.#data.clear()
    this.#close.clear()
  }
}

function connectionSecrets(connection: SshConnection) {
  if (connection.type === "ssh-config") return []
  return [connection.identityFile ?? ""]
}

function classifySshFailure(code: number | null, detail: string) {
  if (/permission denied|authentication failed/i.test(detail)) {
    return new RexdError("ssh", "SSH authentication failed", false, "failed", detail)
  }
  if (/host key verification failed|remote host identification has changed/i.test(detail)) {
    return new RexdError("ssh", "SSH host identity verification failed", false, "failed", detail)
  }
  return new RexdError("ssh", `SSH exited before Rexd started (${code ?? "unknown"})`, true, "failed", detail)
}
