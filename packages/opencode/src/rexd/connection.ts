import path from "node:path"
import { RexdError } from "./error"
import { prepareManagedRexd, managedRexdCommand, type PrepareDependencies, type PrepareResult } from "./prepare"
import { RexdRpcClient, type RexdHandshake } from "./rpc"
import { connectSsh, type RexdTarget, type Transport } from "./ssh"

export type RexdLease = {
  client: RexdRpcClient
  handshake: RexdHandshake
  prepared?: PrepareResult
  close(): Promise<void>
}

export type ConnectionDependencies = PrepareDependencies & {
  connect?: (target: RexdTarget, command: string) => Transport
}

export async function connectRexd(
  target: RexdTarget,
  options: { directory?: string; clientVersion: string; signal?: AbortSignal },
  dependencies: ConnectionDependencies = {},
): Promise<RexdLease> {
  const prepared = target.command ? undefined : await prepareManagedRexd(target, options.signal, dependencies)
  const command = target.command ? commandFromArgv(target.command) : managedRexdCommand(prepared!)
  const transport = (dependencies.connect ?? ((value, remoteCommand) => connectSsh(value.connection, remoteCommand)))(
    target,
    command,
  )
  const client = new RexdRpcClient(transport)
  const handshake = await client
    .open({ clientVersion: options.clientVersion, workspaceRoots: target.workspaceRoots, signal: options.signal })
    .catch(async (error) => {
      await client.close()
      if (error instanceof RexdError) throw error
      throw new RexdError("handshake", "Could not negotiate Rexd session", true)
    })
  if (options.directory)
    await validateDirectory(client, handshake, options.directory, options.signal).catch(async (error) => {
      await closeSession(client, handshake.sessionID)
      throw error
    })
  return {
    client,
    handshake,
    prepared,
    close: () => closeSession(client, handshake.sessionID),
  }
}

export async function testRexdConnection(
  target: RexdTarget,
  options: { directory?: string; clientVersion: string; signal?: AbortSignal },
  dependencies: ConnectionDependencies = {},
) {
  const lease = await connectRexd(target, options, dependencies)
  await lease.close()
  return { handshake: lease.handshake, prepared: lease.prepared }
}

async function validateDirectory(
  client: RexdRpcClient,
  handshake: RexdHandshake,
  directory: string,
  signal?: AbortSignal,
) {
  const normalized = path.posix.normalize(directory)
  if (!path.posix.isAbsolute(normalized)) throw new RexdError("directory", "Remote directory must be absolute", false)
  if (!handshake.workspaceRoots.some((root) => withinRoot(normalized, root))) {
    throw new RexdError("directory", "Remote directory is outside negotiated workspace roots", false)
  }
  const value = await client.request("fs.stat", { session_id: handshake.sessionID, path: normalized }, { signal })
  if (!isRecord(value) || value.exists !== true || value.type !== "dir") {
    throw new RexdError("directory", "Remote directory does not exist or is not accessible", false)
  }
}

async function closeSession(client: RexdRpcClient, sessionID: string) {
  await client
    .request("session.close", { session_id: sessionID }, { timeoutMs: 5_000, sideEffect: true })
    .catch(() => undefined)
  await client.close()
}

function withinRoot(directory: string, root: string) {
  const relative = path.posix.relative(path.posix.normalize(root), directory)
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative))
}

function commandFromArgv(argv: readonly string[]) {
  if (!argv.length) throw new RexdError("launch", "Explicit Rexd command is empty", false)
  return `exec ${argv.map(shellQuote).join(" ")}`
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
