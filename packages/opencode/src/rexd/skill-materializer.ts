import { randomUUID } from "node:crypto"
import path from "node:path"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { Hash } from "@opencode-ai/core/util/hash"
import { Skill } from "@opencode-ai/schema/skill"
import type { RexdLease } from "./connection"
import { contains, RexdFiles } from "./location-files"
import { runRexdProcess } from "./process-runner"

export const ATTACHMENT_TTL_MS = 10 * 60_000
const REMOTE_SKILL_ID = Skill.ID.make(`skl_${"0".repeat(64)}`)

export type FailureKind = "unavailable" | "invalid-root" | "transfer" | "verification" | "commit"

export class Failure extends Error {
  override readonly name = "RexdSkillMaterializer.Failure"

  constructor(
    readonly skillID: Skill.ID,
    readonly kind: FailureKind,
  ) {
    super(`Remote Skill materialization failed: ${kind}`)
  }
}

export type Attachment = {
  readonly path: string
  readonly renew: () => Promise<void>
  readonly release: () => Promise<void>
}

type ProcessResult = Awaited<ReturnType<typeof runRexdProcess>>

export type Dependencies = {
  readonly files?: Files
  readonly run?: (argv: readonly string[], signal?: AbortSignal) => Promise<ProcessResult>
  readonly now?: () => number
  readonly nonce?: () => string
  readonly ttlMs?: number
}

export type Files = Pick<RexdFiles, "roots" | "directoryStatus" | "write" | "readRange" | "stat" | "list" | "delete">

export class Materializer {
  readonly #files: Files
  readonly #run: NonNullable<Dependencies["run"]>
  readonly #now: NonNullable<Dependencies["now"]>
  readonly #nonce: NonNullable<Dependencies["nonce"]>
  readonly #ttlMs: number
  readonly #root?: string
  readonly #active = new Map<string, Promise<void>>()
  readonly #attachments = new Set<Attachment>()
  #initialized?: Promise<void>

  constructor(
    readonly targetID: string,
    readonly lease: RexdLease,
    readonly appID: string,
    dependencies: Dependencies = {},
  ) {
    this.#files = dependencies.files ?? new RexdFiles(targetID, lease)
    this.#run =
      dependencies.run ??
      ((argv, signal) =>
        runRexdProcess(lease, {
          argv,
          shell: false,
          cwd: lease.skillStagingRoot ?? "/",
          timeout: "30 seconds",
          maxOutputBytes: 64 * 1024,
          signal,
        }))
    this.#now = dependencies.now ?? Date.now
    this.#nonce = dependencies.nonce ?? randomUUID
    this.#ttlMs = dependencies.ttlMs ?? ATTACHMENT_TTL_MS
    this.#root = lease.skillStagingRoot ? path.posix.normalize(lease.skillStagingRoot) : undefined
  }

  async materialize(
    snapshot: SkillPackageSnapshot.Snapshot,
    sessionID: string,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    const root = this.#requireRoot(snapshot.skillID)
    validateSnapshot(snapshot)
    await (this.#initialized ??= this.#initialize(root, signal).catch((error) => {
      this.#initialized = undefined
      throw error
    }))
    const packagePath = path.posix.join(root, "packages", snapshot.digest)
    const markerPath = path.posix.join(root, "verified", `${snapshot.digest}.json`)
    const attachment = this.#attach(root, packagePath, snapshot, sessionID)
    await attachment.renew()
    this.#attachments.add(attachment)
    return this.#serialize(snapshot.digest, () =>
      this.#withLock(
        root,
        snapshot,
        async () => {
          if (await this.#verified(packagePath, markerPath, snapshot.digest, signal)) return
          await this.#transfer(root, packagePath, markerPath, snapshot, signal)
        },
        signal,
      ),
    ).then(
      () => attachment,
      async (error) => {
        await attachment.release()
        throw error
      },
    )
  }

  async close() {
    await Promise.allSettled([...this.#attachments].map((attachment) => attachment.release()))
  }

  async sweep(signal?: AbortSignal) {
    const root = this.#root
    if (!root || !this.#validRoot(root)) return
    await this.#sweep(root, signal)
  }

  async #initialize(root: string, signal?: AbortSignal) {
    const sentinel = path.posix.join(root, ".initialize")
    await this.#files.write(sentinel, "/", new Uint8Array()).catch(() => {
      throw new Failure(REMOTE_SKILL_ID, "unavailable")
    })
    await this.#files.delete(sentinel, "/").catch(() => undefined)
    await this.#command(
      [
        "mkdir",
        "-p",
        path.posix.join(root, "packages"),
        path.posix.join(root, "verified"),
        path.posix.join(root, "staging"),
        path.posix.join(root, "attachments"),
        path.posix.join(root, "locks"),
      ],
      "unavailable",
      signal,
    )
    await this.#sweep(root, signal)
  }

  async #transfer(
    root: string,
    packagePath: string,
    markerPath: string,
    snapshot: SkillPackageSnapshot.Snapshot,
    signal?: AbortSignal,
  ) {
    const staging = path.posix.join(
      root,
      "staging",
      `${snapshot.digest}.${this.#now()}.${safeHash(this.appID)}.${safeHash(this.#nonce())}`,
    )
    await this.#command(["mkdir", "-p", staging], "transfer", signal, snapshot.skillID)
    let committed = false
    try {
      for (const file of snapshot.files) {
        const target = path.posix.join(staging, file.path)
        if (file.content.length === 0) {
          await this.#files.write(target, "/", file.content)
          continue
        }
        for (let offset = 0; offset < file.content.length; offset += SkillPackageSnapshot.READ_CHUNK_BYTES) {
          await this.#files.write(
            target,
            "/",
            file.content.subarray(offset, offset + SkillPackageSnapshot.READ_CHUNK_BYTES),
            { mode: offset === 0 ? "replace" : "append" },
          )
        }
      }
      await this.#verify(staging, snapshot, signal)
      await this.#remove(packagePath, snapshot.skillID, signal)
      await this.#files.delete(markerPath, "/").catch(() => undefined)
      await this.#command(["mv", staging, packagePath], "commit", signal, snapshot.skillID)
      committed = true
      await this.#files.write(
        markerPath,
        "/",
        Buffer.from(JSON.stringify({ digest: snapshot.digest, files: snapshot.files.length, size: snapshot.size })),
      )
    } catch (error) {
      await this.#remove(staging, snapshot.skillID, signal).catch(() => undefined)
      if (committed) await this.#remove(packagePath, snapshot.skillID, signal).catch(() => undefined)
      await this.#files.delete(markerPath, "/").catch(() => undefined)
      if (error instanceof Failure) throw error
      throw new Failure(snapshot.skillID, "transfer")
    }
  }

  async #verify(staging: string, snapshot: SkillPackageSnapshot.Snapshot, signal?: AbortSignal) {
    for (const file of snapshot.files) {
      const hash = new Bun.CryptoHasher("sha256")
      let received = 0
      while (received < file.size) {
        const expected = Math.min(SkillPackageSnapshot.READ_CHUNK_BYTES, file.size - received)
        const result = await this.#files.readRange(path.posix.join(staging, file.path), "/", received, expected, signal)
        if (result.content.length !== expected || result.size !== file.size)
          throw new Failure(snapshot.skillID, "verification")
        hash.update(result.content)
        received += result.content.length
      }
      if (file.size === 0) {
        const stat = await this.#files.stat(path.posix.join(staging, file.path), "/", signal)
        if (!stat.exists || stat.type !== "file") throw new Failure(snapshot.skillID, "verification")
      }
      if (hash.digest("hex") !== file.digest) throw new Failure(snapshot.skillID, "verification")
    }
    const digest = Skill.Digest.make(
      Hash.sha256(JSON.stringify(snapshot.files.map((file) => [file.path, file.size, file.digest]))),
    )
    if (digest !== snapshot.digest) throw new Failure(snapshot.skillID, "verification")
  }

  async #verified(packagePath: string, markerPath: string, digest: Skill.Digest, signal?: AbortSignal) {
    const status = await this.#files.directoryStatus(packagePath, "/", signal).catch(() => undefined)
    if (status?.status !== "directory") return false
    const marker = await this.#files.readRange(markerPath, "/", 0, 1024, signal).catch(() => undefined)
    if (!marker) return false
    try {
      const value: unknown = JSON.parse(marker.content.toString("utf8"))
      return isRecord(value) && value.digest === digest
    } catch {
      return false
    }
  }

  #attach(root: string, packagePath: string, snapshot: SkillPackageSnapshot.Snapshot, sessionID: string): Attachment {
    const record = path.posix.join(
      root,
      "attachments",
      safeHash(this.appID),
      safeHash(sessionID),
      `${snapshot.digest}.${safeHash(this.#nonce())}.json`,
    )
    let timer: ReturnType<typeof setInterval> | undefined
    let released = false
    const renew = async () => {
      if (released) return
      await this.#files.write(
        record,
        "/",
        Buffer.from(JSON.stringify({ digest: snapshot.digest, expiresAt: this.#now() + this.#ttlMs })),
      )
      if (timer) return
      timer = setInterval(() => void renew().catch(() => undefined), Math.max(1_000, Math.floor(this.#ttlMs / 3)))
      timer.unref?.()
    }
    const attachment: Attachment = {
      path: packagePath,
      renew,
      release: async () => {
        if (released) return
        released = true
        if (timer) clearInterval(timer)
        this.#attachments.delete(attachment)
        await this.#files.delete(record, "/").catch(() => undefined)
        await this.#serialize(snapshot.digest, async () => {
          if (await this.#hasAttachment(root, snapshot.digest)) return
          await this.#remove(packagePath, snapshot.skillID).catch(() => undefined)
          await this.#files
            .delete(path.posix.join(root, "verified", `${snapshot.digest}.json`), "/")
            .catch(() => undefined)
        })
      },
    }
    return attachment
  }

  async #sweep(root: string, signal?: AbortSignal) {
    const attachments = await this.#files.list(path.posix.join(root, "attachments"), "/", true).catch(() => [])
    await Promise.all(
      attachments
        .filter((entry) => entry.type === "file" && entry.name.endsWith(".json"))
        .map(async (entry) => {
          const record = await this.#files.readRange(entry.path, "/", 0, 4096, signal).catch(() => undefined)
          if (!record) return
          try {
            const value: unknown = JSON.parse(record.content.toString("utf8"))
            if (isRecord(value) && typeof value.expiresAt === "number" && value.expiresAt > this.#now()) return
          } catch {}
          await this.#files.delete(entry.path, "/").catch(() => undefined)
        }),
    )
    const staging = await this.#files.list(path.posix.join(root, "staging"), "/").catch(() => [])
    await Promise.all(
      staging
        .filter((entry) => {
          if (entry.type !== "dir") return false
          const match = /^[a-f0-9]{64}\.(\d+)\./.exec(entry.name)
          return match ? Number(match[1]) <= this.#now() - this.#ttlMs : false
        })
        .map((entry) => this.#remove(entry.path, REMOTE_SKILL_ID, signal).catch(() => undefined)),
    )
    const locks = await this.#files.list(path.posix.join(root, "locks"), "/").catch(() => [])
    await Promise.all(
      locks
        .filter((entry) => entry.type === "dir" && /^[a-f0-9]{64}$/.test(entry.name))
        .map(async (entry) => {
          const record = await this.#files
            .readRange(path.posix.join(entry.path, "owner.json"), "/", 0, 4096, signal)
            .catch(() => undefined)
          if (!record) return
          try {
            const value: unknown = JSON.parse(record.content.toString("utf8"))
            if (isRecord(value) && typeof value.expiresAt === "number" && value.expiresAt > this.#now()) return
          } catch {}
          await this.#remove(entry.path, REMOTE_SKILL_ID, signal).catch(() => undefined)
        }),
    )
    const packages = await this.#files.list(path.posix.join(root, "packages"), "/").catch(() => [])
    await Promise.all(
      packages
        .filter((entry) => entry.type === "dir" && /^[a-f0-9]{64}$/.test(entry.name))
        .map(async (entry) => {
          if (await this.#hasAttachment(root, entry.name)) return
          await this.#remove(entry.path, REMOTE_SKILL_ID, signal).catch(() => undefined)
          await this.#files.delete(path.posix.join(root, "verified", `${entry.name}.json`), "/").catch(() => undefined)
        }),
    )
    const verified = await this.#files.list(path.posix.join(root, "verified"), "/").catch(() => [])
    await Promise.all(
      verified
        .filter((entry) => entry.type === "file" && /^[a-f0-9]{64}\.json$/.test(entry.name))
        .map(async (entry) => {
          const digest = entry.name.slice(0, -".json".length)
          const status = await this.#files
            .directoryStatus(path.posix.join(root, "packages", digest), "/", signal)
            .catch(() => undefined)
          if (status?.status === "directory") return
          await this.#files.delete(entry.path, "/").catch(() => undefined)
        }),
    )
  }

  async #hasAttachment(root: string, digest: string) {
    return (await this.#files.list(path.posix.join(root, "attachments"), "/", true).catch(() => [])).some(
      (entry) => entry.type === "file" && entry.name.startsWith(`${digest}.`) && entry.name.endsWith(".json"),
    )
  }

  async #withLock(
    root: string,
    snapshot: SkillPackageSnapshot.Snapshot,
    operation: () => Promise<void>,
    signal?: AbortSignal,
  ) {
    const lock = path.posix.join(root, "locks", snapshot.digest)
    const owner = path.posix.join(lock, "owner.json")
    const deadline = Date.now() + 30_000
    while (true) {
      if (signal?.aborted) throw new Failure(snapshot.skillID, "transfer")
      const created = await this.#run(["mkdir", lock], signal).catch(() => {
        throw new Failure(snapshot.skillID, "transfer")
      })
      if (created.exitCode === 0) break
      const record = await this.#files.readRange(owner, "/", 0, 4096, signal).catch(() => undefined)
      if (record) {
        try {
          const value: unknown = JSON.parse(record.content.toString("utf8"))
          if (isRecord(value) && typeof value.expiresAt === "number" && value.expiresAt <= this.#now()) {
            await this.#remove(lock, snapshot.skillID, signal).catch(() => undefined)
            continue
          }
        } catch {}
      }
      if (Date.now() >= deadline) throw new Failure(snapshot.skillID, "transfer")
      await Bun.sleep(50)
    }
    await this.#files
      .write(owner, "/", Buffer.from(JSON.stringify({ expiresAt: this.#now() + this.#ttlMs * 3 })))
      .catch(async () => {
        await this.#remove(lock, snapshot.skillID, signal).catch(() => undefined)
        throw new Failure(snapshot.skillID, "transfer")
      })
    try {
      await operation()
    } finally {
      await this.#remove(lock, snapshot.skillID, signal).catch(() => undefined)
    }
  }

  async #remove(target: string, skillID: Skill.ID, signal?: AbortSignal) {
    const root = this.#requireRoot(skillID)
    if (!contains(root, target) || target === root) throw new Failure(skillID, "invalid-root")
    await this.#command(["rm", "-rf", target], "commit", signal, skillID)
  }

  async #command(argv: readonly string[], kind: FailureKind, signal?: AbortSignal, skillID = REMOTE_SKILL_ID) {
    const result = await this.#run(argv, signal).catch(() => {
      throw new Failure(skillID, kind)
    })
    if (result.exitCode !== 0 || result.stdoutTruncated || result.stderrTruncated) throw new Failure(skillID, kind)
  }

  async #serialize(digest: string, operation: () => Promise<void>) {
    const current = this.#active.get(digest)
    if (current) return current
    const active = operation().finally(() => this.#active.delete(digest))
    this.#active.set(digest, active)
    return active
  }

  #requireRoot(skillID: Skill.ID) {
    if (!this.#root || !this.#validRoot(this.#root)) throw new Failure(skillID, "unavailable")
    return this.#root
  }

  #validRoot(root: string) {
    return (
      path.posix.isAbsolute(root) &&
      root !== "/" &&
      !root.includes("\0") &&
      this.#files.roots.some((candidate) => path.posix.normalize(candidate) === root)
    )
  }
}

function validateSnapshot(snapshot: SkillPackageSnapshot.Snapshot) {
  if (!/^[a-f0-9]{64}$/.test(snapshot.digest)) throw new Failure(snapshot.skillID, "verification")
  if (
    snapshot.files.length > SkillPackageSnapshot.MAX_FILES ||
    snapshot.size > SkillPackageSnapshot.MAX_PACKAGE_BYTES ||
    snapshot.files.reduce((total, file) => total + file.content.length, 0) !== snapshot.size
  )
    throw new Failure(snapshot.skillID, "verification")
  if (
    snapshot.files.some(
      (file) =>
        path.posix.isAbsolute(file.path) ||
        path.posix.normalize(file.path) !== file.path ||
        file.path.startsWith("../") ||
        file.content.length !== file.size ||
        file.content.length > SkillPackageSnapshot.MAX_FILE_BYTES,
    )
  )
    throw new Failure(snapshot.skillID, "verification")
}

function safeHash(value: string) {
  return Hash.sha256(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as RexdSkillMaterializer from "./skill-materializer"
