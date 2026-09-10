import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { TargetRegistry } from "@opencode-ai/core/target-registry"
import { Hash } from "@opencode-ai/core/util/hash"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { Context, Effect, Layer } from "effect"
import path from "node:path"
import type { RexdLease } from "./connection"
import { RexdConnectionPool } from "./connection-pool"
import { RexdFiles } from "./location-files"
import { runRexdProcess } from "./process-runner"

export class RexdLocationSession extends Context.Service<RexdLocationSession, RexdLease>()(
  "@opencode/RexdLocationSession",
) {}

export function rexdSessionNode(ref: Location.Ref) {
  if (ref.target.type !== "rexd") throw new Error("Rexd provider received a local Location")
  const targetID = ref.target.targetID
  return makeLocationNode({
    service: RexdLocationSession,
    layer: Layer.effect(
      RexdLocationSession,
      Effect.gen(function* () {
        const registry = yield* TargetRegistry.Service
        const snapshot = yield* Effect.promise(() => registry.load())
        const target = snapshot.targets.find((item) => item.id === targetID)
        if (!target) return yield* Effect.die(new Error(`Rexd target is unavailable: ${targetID}`))
        const pool = yield* RexdConnectionPool.Service
        const handle = yield* Effect.acquireRelease(
          Effect.tryPromise(() =>
            pool.acquire(target, { directory: ref.directory, clientVersion: InstallationVersion }),
          ),
          (current) => Effect.promise(() => current.release()),
        )
        return handle.lease
      }),
    ),
    deps: [TargetRegistry.node, RexdConnectionPool.node],
  })
}

export function rexdLocationNode(ref: Location.Ref, session: ReturnType<typeof rexdSessionNode>) {
  if (ref.target.type !== "rexd") throw new Error("Rexd provider received a local Location")
  const targetID = ref.target.targetID
  return makeLocationNode({
    service: Location.Service,
    layer: Layer.effect(
      Location.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        const registry = yield* TargetRegistry.Service
        const snapshot = yield* Effect.promise(() => registry.load())
        const target = snapshot.targets.find((item) => item.id === targetID)
        const metadata = yield* Effect.promise(() => inspectRexdLocation(targetID, ref.directory, lease))
        return Location.Service.of({
          target: ref.target,
          directory: ref.directory,
          workspaceID: ref.workspaceID,
          lastKnownTargetName: ref.lastKnownTargetName,
          project: {
            id: Project.ID.make(Hash.fast(`rexd:${targetID}:${metadata.project}`)),
            directory: AbsolutePath.make(metadata.project),
          },
          vcs: metadata.vcs ? { type: "git", store: AbsolutePath.make(metadata.project) } : undefined,
          platform: lease.prepared?.platform ?? "unknown",
          targetName: target?.name ?? ref.lastKnownTargetName ?? "remote",
          home: lease.prepared?.home,
          canonicalDirectory: metadata.directory,
        })
      }),
    ),
    deps: [session, TargetRegistry.node],
  })
}

/** Discover target-side project identity without opening another SSH connection. */
export async function inspectRexdLocation(targetID: Location.TargetID, directory: string, lease: RexdLease) {
  const logical = path.posix.normalize(directory)
  const fallback = { directory: logical, project: logical, vcs: false as const }
  try {
    const files = new RexdFiles(targetID, lease)
    const status = await files.directoryStatus(directory, "/")
    const cwd = status.status === "directory" ? (status.resolvedPath ?? status.path) : directory
    const result = await runRexdProcess(lease, {
      argv: ["git", "-C", cwd, "rev-parse", "--show-toplevel"],
      shell: false,
      cwd,
      timeout: "5 seconds",
      maxOutputBytes: 64 * 1024,
    })
    const nonGit = { ...fallback, directory: cwd, project: cwd }
    if (result.exitCode !== 0 || result.stdoutTruncated) return nonGit
    const candidate = path.posix.normalize(result.stdout.toString("utf8").trim().split("\n", 1)[0] ?? "")
    if (!path.posix.isAbsolute(candidate) || !lease.handshake.workspaceRoots.some((root) => within(root, candidate)))
      return nonGit
    const root = await files.directoryStatus(candidate, "/")
    if (root.status !== "directory") return nonGit
    return { directory: cwd, project: root.resolvedPath ?? candidate, vcs: true as const }
  } catch {
    return fallback
  }
}

function within(root: string, value: string) {
  const relative = path.posix.relative(path.posix.normalize(root), path.posix.normalize(value))
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative))
}
