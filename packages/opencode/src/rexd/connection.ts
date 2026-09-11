import path from "node:path"
import { RexdError } from "./error"
import { RexdFiles } from "./location-files"
import {
  MANAGED_SKILL_STAGING_ROOT,
  prepareManagedRexd,
  managedRexdCommand,
  type PrepareDependencies,
  type PrepareResult,
} from "./prepare"
import { RexdRpcClient, type RexdHandshake } from "./rpc"
import { connectSsh, posixRemoteCommand, type RexdTarget, type Transport } from "./ssh"

export type RexdLease = {
  client: RexdRpcClient
  handshake: RexdHandshake
  prepared?: PrepareResult
  skillStagingRoot?: string
  close(): Promise<void>
}

export type ConnectionDependencies = PrepareDependencies & {
  connect?: (target: RexdTarget, command: string) => Transport
  renderCommand?: (command: NonNullable<RexdTarget["command"]>) => string
}

export async function connectRexd(
  target: RexdTarget,
  options: { directory?: string; clientVersion: string; signal?: AbortSignal },
  dependencies: ConnectionDependencies = {},
): Promise<RexdLease> {
  const prepared = target.command ? undefined : await prepareManagedRexd(target, options.signal, dependencies)
  const command = target.command
    ? (dependencies.renderCommand ?? posixRemoteCommand)(target.command)
    : managedRexdCommand(prepared!)
  const transport = (dependencies.connect ?? ((value, remoteCommand) => connectSsh(value.connection, remoteCommand)))(
    target,
    command,
  )
  const client = new RexdRpcClient(transport)
  const configuredSkillStagingRoot = target.command ? target.skillStagingRoot : MANAGED_SKILL_STAGING_ROOT
  const skillStagingRoot = configuredSkillStagingRoot ? path.posix.normalize(configuredSkillStagingRoot) : undefined
  const requestedRoots = skillStagingRoot
    ? [...new Set([...target.workspaceRoots, skillStagingRoot])]
    : target.workspaceRoots
  const handshake = await client
    .open({ clientVersion: options.clientVersion, workspaceRoots: requestedRoots, signal: options.signal })
    .catch(async (error) => {
      await client.close()
      if (error instanceof RexdError) throw error
      throw new RexdError("handshake", "Could not negotiate Rexd session", true)
    })
  const lease: RexdLease = {
    client,
    handshake,
    prepared,
    skillStagingRoot: handshake.workspaceRoots.some((root) => path.posix.normalize(root) === skillStagingRoot)
      ? skillStagingRoot
      : undefined,
    close: () => closeSession(client, handshake.sessionID),
  }
  if (options.directory)
    await validateRexdDirectory(target.id, lease, options.directory, options.signal).catch(async (error) => {
      await lease.close()
      throw error
    })
  return lease
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

export async function validateRexdDirectory(
  targetID: string,
  lease: RexdLease,
  directory: string,
  signal?: AbortSignal,
) {
  const normalized = path.posix.normalize(directory)
  if (!path.posix.isAbsolute(normalized)) throw new RexdError("directory", "Remote directory must be absolute", false)
  if (!lease.handshake.workspaceRoots.some((root) => withinRoot(normalized, root))) {
    throw new RexdError("directory", "Remote directory is outside negotiated workspace roots", false)
  }
  const value = await new RexdFiles(targetID, lease).directoryStatus(normalized, "/", signal)
  if (value.status !== "directory") {
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
