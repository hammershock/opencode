import path from "node:path"
import { Schema } from "effect"
import type { RexdLease } from "./connection"

const Stat = Schema.Struct({
  path: Schema.String,
  exists: Schema.Boolean,
  type: Schema.optional(Schema.Literals(["file", "dir", "symlink", "other"])),
  mtime: Schema.optional(Schema.NullOr(Schema.Number)),
  symlink_target: Schema.optional(Schema.String),
})
const Read = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  mtime: Schema.Number,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  truncated: Schema.Boolean,
})
const List = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      path: Schema.String,
      type: Schema.Literals(["file", "dir", "symlink", "other"]),
    }),
  ),
})
const Glob = Schema.Struct({ matches: Schema.Array(Schema.String) })

export type RexdDirectoryStatus = {
  readonly status: "directory" | "missing" | "not-directory"
  readonly path: string
  readonly resolvedPath?: string
  readonly reason?: "broken-symlink" | "symlink-loop" | "outside-roots"
}

export class RexdFiles {
  readonly roots: readonly string[]

  constructor(
    readonly targetID: string,
    readonly lease: RexdLease,
  ) {
    this.roots = lease.handshake.workspaceRoots.map((item) => path.posix.normalize(item))
  }

  resolve(value: string, cwd: string) {
    const resolved = path.posix.normalize(path.posix.isAbsolute(value) ? value : path.posix.join(cwd, value))
    if (!this.roots.some((root) => contains(root, resolved)))
      throw new Error(`Remote path is outside negotiated roots for ${this.targetID}: ${resolved}`)
    return resolved
  }

  async stat(value: string, cwd: string, signal?: AbortSignal) {
    return Schema.decodeUnknownSync(Stat)(
      await this.lease.client.request(
        "fs.stat",
        { session_id: this.lease.handshake.sessionID, path: this.resolve(value, cwd) },
        { signal },
      ),
    )
  }

  async statFollowing(value: string, cwd: string, signal?: AbortSignal) {
    const requested = this.resolve(value, cwd)
    return this.followStat(requested, new Set(), signal)
  }

  async directoryStatus(value: string, cwd: string, signal?: AbortSignal): Promise<RexdDirectoryStatus> {
    const requested = this.resolve(value, cwd)
    return this.followDirectory(requested, requested, new Set(), signal)
  }

  async read(value: string, cwd: string, signal?: AbortSignal) {
    const target = this.resolve(value, cwd)
    const result = Schema.decodeUnknownSync(Read)(
      await this.lease.client.request(
        "fs.read",
        { session_id: this.lease.handshake.sessionID, path: target },
        { signal },
      ),
    )
    if (result.truncated)
      throw new Error(`Remote file exceeds the negotiated Rexd read limit and cannot be read safely: ${target}`)
    return { content: Buffer.from(result.content, result.encoding), mtime: result.mtime }
  }

  async readRange(value: string, cwd: string, offset: number, length: number, signal?: AbortSignal) {
    const target = this.resolve(value, cwd)
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1)
      throw new Error("Remote read range must use a non-negative offset and positive length")
    const result = Schema.decodeUnknownSync(Read)(
      await this.lease.client.request(
        "fs.read",
        { session_id: this.lease.handshake.sessionID, path: target, offset, length, encoding: "base64" },
        { signal },
      ),
    )
    const content = Buffer.from(result.content, result.encoding)
    if (content.length > length) throw new Error(`Remote file returned more bytes than requested: ${target}`)
    return { content, mtime: result.mtime, size: result.size, truncated: result.truncated }
  }

  async list(value: string, cwd: string, recursive = false) {
    return Schema.decodeUnknownSync(List)(
      await this.lease.client.request("fs.list", {
        session_id: this.lease.handshake.sessionID,
        path: this.resolve(value, cwd),
        recursive,
        max_entries: 100_000,
      }),
    ).entries
  }

  async glob(pattern: string, cwd: string) {
    return Schema.decodeUnknownSync(Glob)(
      await this.lease.client.request("fs.glob", {
        session_id: this.lease.handshake.sessionID,
        pattern,
        cwd: this.resolve(cwd, cwd),
      }),
    ).matches
  }

  async write(
    value: string,
    cwd: string,
    content: Uint8Array,
    options: { mode?: string; expectedMtime?: number } = {},
  ) {
    return this.lease.client.request(
      "fs.write",
      {
        session_id: this.lease.handshake.sessionID,
        path: this.resolve(value, cwd),
        content: Buffer.from(content).toString("base64"),
        encoding: "base64",
        mode: options.mode ?? "replace",
        mkdir_parents: true,
        atomic: true,
        expected_mtime: options.expectedMtime,
      },
      { sideEffect: true },
    )
  }

  async delete(value: string, cwd: string) {
    const target = this.resolve(value, cwd)
    return this.lease.client.request(
      "fs.patch",
      {
        session_id: this.lease.handshake.sessionID,
        cwd: path.posix.dirname(target),
        patch_text: `*** Begin Patch\n*** Delete File: ${path.posix.basename(target)}\n*** End Patch`,
      },
      { sideEffect: true },
    )
  }

  private async followDirectory(
    requested: string,
    current: string,
    visited: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<RexdDirectoryStatus> {
    if (visited.has(current) || visited.size >= 40)
      return { status: "not-directory", path: requested, reason: "symlink-loop" }
    if (!this.roots.some((root) => contains(root, current)))
      return { status: "not-directory", path: requested, reason: "outside-roots" }
    const item = await this.stat(current, "/", signal)
    if (!item.exists)
      return current === requested
        ? { status: "missing", path: requested }
        : { status: "not-directory", path: requested, reason: "broken-symlink" }
    if (item.type === "dir") return { status: "directory", path: requested, resolvedPath: current }
    if (item.type !== "symlink" || !item.symlink_target) return { status: "not-directory", path: requested }
    const target = path.posix.resolve(path.posix.dirname(current), item.symlink_target)
    return this.followDirectory(requested, target, new Set([...visited, current]), signal)
  }

  private async followStat(
    current: string,
    visited: ReadonlySet<string>,
    signal?: AbortSignal,
  ): Promise<typeof Stat.Type> {
    if (visited.has(current) || visited.size >= 40) throw new Error(`Remote symlink loop: ${current}`)
    if (!this.roots.some((root) => contains(root, current)))
      throw new Error(`Remote symlink target is outside negotiated roots: ${current}`)
    const item = await this.stat(current, "/", signal)
    if (item.type !== "symlink" || !item.symlink_target) return item
    const target = path.posix.resolve(path.posix.dirname(current), item.symlink_target)
    return this.followStat(target, new Set([...visited, current]), signal)
  }
}

export function contains(root: string, value: string) {
  return root === "/" ? value.startsWith("/") : value === root || value.startsWith(`${root}/`)
}
