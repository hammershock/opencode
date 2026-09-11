import { describe, expect, test } from "bun:test"
import path from "node:path"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Skill } from "@opencode-ai/schema/skill"
import type { RexdLease } from "../../src/rexd/connection"
import { RexdSkillMaterializer } from "../../src/rexd/skill-materializer"

const root = "/tmp/opencode-transit/skills"

describe("Rexd Skill package materializer", () => {
  test("chunks, verifies, commits, caches, shares, and releases one binary package", async () => {
    const remote = new Remote()
    const materializer = new RexdSkillMaterializer.Materializer("gpu", lease(), "app", {
      files: remote,
      run: remote.run,
      now: () => 1_000,
      nonce: () => "nonce",
    })
    const value = snapshot([
      ["SKILL.md", Buffer.from("review")],
      [
        "assets/data.bin",
        Buffer.concat([Buffer.alloc(SkillPackageSnapshot.READ_CHUNK_BYTES, 7), Buffer.from([0, 255])]),
      ],
    ])

    const [first, second] = await Promise.all([
      materializer.materialize(value, "session-a"),
      materializer.materialize(value, "session-b"),
    ])

    expect(first.path).toBe(`${root}/packages/${value.digest}`)
    expect(second.path).toBe(first.path)
    expect(remote.content(`${first.path}/assets/data.bin`)).toEqual(Buffer.from(value.files[1]!.content))
    expect(remote.writes.filter((item) => item.path.includes("/staging/")).map((item) => item.size)).toEqual([
      6,
      SkillPackageSnapshot.READ_CHUNK_BYTES,
      2,
    ])
    expect(remote.writes.filter((item) => item.path.endsWith("data.bin")).map((item) => item.mode)).toEqual([
      "replace",
      "append",
    ])
    expect(remote.reads.every((item) => item.length <= SkillPackageSnapshot.READ_CHUNK_BYTES)).toBe(true)
    expect(remote.commands.filter((item) => item[0] === "mv")).toHaveLength(1)

    await first.release()
    expect(remote.has(first.path)).toBe(true)
    await second.release()
    expect(remote.has(first.path)).toBe(false)
    await materializer.close()
  })

  test("a cache hit creates only an attachment and does not retransmit", async () => {
    const remote = new Remote()
    const value = snapshot([["SKILL.md", Buffer.from("review")]])
    const first = new RexdSkillMaterializer.Materializer("gpu", lease(), "app-a", {
      files: remote,
      run: remote.run,
      now: () => 1_000,
      nonce: () => "first",
    })
    const original = await first.materialize(value, "session-a")
    const writes = remote.writes.length
    const second = new RexdSkillMaterializer.Materializer("gpu", lease(), "app-b", {
      files: remote,
      run: remote.run,
      now: () => 1_001,
      nonce: () => "second",
    })
    const cached = await second.materialize(value, "session-b")

    expect(remote.writes.slice(writes).filter((item) => item.path.includes("/staging/"))).toEqual([])
    expect(remote.writes.slice(writes).some((item) => item.path.includes("/attachments/"))).toBe(true)
    expect(cached.path).toBe(original.path)
    await original.release()
    await cached.release()
  })

  test("serializes the same digest across materializer instances with a target lock", async () => {
    const remote = new Remote()
    remote.writeDelayMs = 5
    const value = snapshot([["SKILL.md", Buffer.from("review")]])
    const first = new RexdSkillMaterializer.Materializer("gpu", lease(), "app-a", {
      files: remote,
      run: remote.run,
      nonce: () => "first",
    })
    const second = new RexdSkillMaterializer.Materializer("gpu", lease(), "app-b", {
      files: remote,
      run: remote.run,
      nonce: () => "second",
    })

    const attachments = await Promise.all([
      first.materialize(value, "session-a"),
      second.materialize(value, "session-b"),
    ])
    expect(remote.commands.filter((item) => item[0] === "mv")).toHaveLength(1)
    expect(attachments[0].path).toBe(attachments[1].path)
    await Promise.all(attachments.map((attachment) => attachment.release()))
  })

  test("verification failure removes staging and exposes no package", async () => {
    const remote = new Remote()
    remote.corrupt = true
    const value = snapshot([["SKILL.md", Buffer.from("review")]])
    const materializer = new RexdSkillMaterializer.Materializer("gpu", lease(), "app", {
      files: remote,
      run: remote.run,
      now: () => 1_000,
      nonce: () => "broken",
    })

    await expect(materializer.materialize(value, "session")).rejects.toMatchObject({
      name: "RexdSkillMaterializer.Failure",
      kind: "verification",
      skillID: value.skillID,
    })
    expect(remote.entries(`${root}/staging`)).toEqual([])
    expect(remote.entries(`${root}/packages`)).toEqual([])
  })

  test("fails closed when the staging root was not handshake-confirmed", async () => {
    const remote = new Remote()
    const materializer = new RexdSkillMaterializer.Materializer(
      "gpu",
      { ...lease(), skillStagingRoot: undefined },
      "app",
      {
        files: remote,
        run: remote.run,
      },
    )

    await expect(
      materializer.materialize(snapshot([["SKILL.md", Buffer.from("review")]]), "session"),
    ).rejects.toMatchObject({
      kind: "unavailable",
    })
    expect(remote.writes).toEqual([])
    expect(remote.commands).toEqual([])
  })

  test("sweeps expired attachments and retries failed stale cleanup", async () => {
    let now = 1_000
    const remote = new Remote()
    const value = snapshot([["SKILL.md", Buffer.from("review")]])
    const crashed = new RexdSkillMaterializer.Materializer("gpu", lease(), "old-app", {
      files: remote,
      run: remote.run,
      now: () => now,
      nonce: () => "old",
      ttlMs: 3_000,
    })
    const attached = await crashed.materialize(value, "old-session")
    await remote.run(["mkdir", "-p", `${root}/staging/${value.digest}.100.old.partial`])
    now = 5_000
    remote.failRemove = true
    const recovered = new RexdSkillMaterializer.Materializer("gpu", lease(), "new-app", {
      files: remote,
      run: remote.run,
      now: () => now,
      ttlMs: 3_000,
    })

    await recovered.sweep()
    expect(remote.has(attached.path)).toBe(true)
    expect(remote.entries(`${root}/staging`)).not.toEqual([])
    remote.failRemove = false
    await recovered.sweep()
    expect(remote.has(attached.path)).toBe(false)
    expect(remote.entries(`${root}/staging`)).toEqual([])
    await crashed.close()
  })
})

function lease() {
  return {
    handshake: { sessionID: "rexd-session", workspaceRoots: ["/workspace", root] },
    skillStagingRoot: root,
  } as unknown as RexdLease
}

function snapshot(files: ReadonlyArray<readonly [string, Uint8Array]>): SkillPackageSnapshot.Snapshot {
  const entries = files.map(([file, content]) => ({
    path: RelativePath.make(file),
    size: content.length,
    digest: Skill.Digest.make(Hash.sha256(Buffer.from(content))),
    content,
  }))
  return {
    skillID: Skill.ID.make(`skl_${"1".repeat(64)}`),
    root: AbsolutePath.make("/controller/skill"),
    files: entries,
    size: entries.reduce((total, file) => total + file.size, 0),
    digest: Skill.Digest.make(Hash.sha256(JSON.stringify(entries.map((file) => [file.path, file.size, file.digest])))),
  }
}

class Remote {
  readonly roots = [root]
  readonly files = new Map<string, Buffer>()
  readonly directories = new Set<string>(["/"])
  readonly writes: Array<{ path: string; size: number; mode: string }> = []
  readonly reads: Array<{ path: string; offset: number; length: number }> = []
  readonly commands: readonly string[][] = []
  corrupt = false
  failRemove = false
  writeDelayMs = 0

  readonly run = async (argv: readonly string[]) => {
    ;(this.commands as string[][]).push([...argv])
    const mkdirTargets = argv[0] === "mkdir" ? (argv[1] === "-p" ? argv.slice(2) : argv.slice(1)) : []
    const mkdirConflict = argv[0] === "mkdir" && argv[1] !== "-p" && mkdirTargets.some((item) => this.has(item))
    if (!mkdirConflict) mkdirTargets.forEach((item) => this.mkdir(item))
    if (argv[0] === "rm" && !this.failRemove) this.remove(argv[2]!)
    if (argv[0] === "mv") this.move(argv[1]!, argv[2]!)
    return {
      command: argv.join(" "),
      exitCode: (argv[0] === "rm" && this.failRemove) || mkdirConflict ? 1 : 0,
      output: Buffer.alloc(0),
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      outputTruncated: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    }
  }

  async directoryStatus(value: string) {
    return this.directories.has(value)
      ? ({ status: "directory", path: value, resolvedPath: value } as const)
      : ({ status: "missing", path: value } as const)
  }

  async write(value: string, _cwd: string, content: Uint8Array, options: { mode?: string } = {}) {
    if (this.writeDelayMs && value.includes("/staging/")) await Bun.sleep(this.writeDelayMs)
    const mode = options.mode ?? "replace"
    this.mkdir(path.posix.dirname(value))
    this.files.set(
      value,
      mode === "append" ? Buffer.concat([this.files.get(value) ?? Buffer.alloc(0), content]) : Buffer.from(content),
    )
    this.writes.push({ path: value, size: content.length, mode })
  }

  async readRange(value: string, _cwd: string, offset: number, length: number) {
    const content = this.files.get(value)
    if (!content) throw new Error("missing")
    this.reads.push({ path: value, offset, length })
    const result = Buffer.from(content.subarray(offset, offset + length))
    if (this.corrupt && value.includes("/staging/") && result.length) result[0] ^= 0xff
    return { content: result, mtime: 1, size: content.length, truncated: offset + length < content.length }
  }

  async stat(value: string) {
    if (this.files.has(value)) return { path: value, exists: true, type: "file" as const, mtime: 1 }
    if (this.directories.has(value)) return { path: value, exists: true, type: "dir" as const, mtime: 1 }
    return { path: value, exists: false, mtime: 1 }
  }

  async list(value: string, _cwd: string, recursive = false) {
    if (!this.directories.has(value)) throw new Error("missing")
    return [
      ...[...this.directories]
        .filter((item) => item !== value && path.posix.dirname(item) === value)
        .map((item) => ({ name: path.posix.basename(item), path: item, type: "dir" as const })),
      ...[...this.files]
        .filter(([item]) => (recursive ? item.startsWith(`${value}/`) : path.posix.dirname(item) === value))
        .map(([item]) => ({ name: path.posix.basename(item), path: item, type: "file" as const })),
    ]
  }

  async delete(value: string) {
    this.files.delete(value)
  }

  content(value: string) {
    return this.files.get(value)
  }

  has(value: string) {
    return this.directories.has(value)
  }

  entries(value: string) {
    return [...this.directories, ...this.files.keys()].filter((item) => item.startsWith(`${value}/`))
  }

  private mkdir(value: string) {
    const parts = path.posix.normalize(value).split("/").filter(Boolean)
    parts.reduce((current, part) => {
      const next = `${current}/${part}`
      this.directories.add(next)
      return next
    }, "")
  }

  private remove(value: string) {
    ;[...this.files.keys()]
      .filter((item) => item === value || item.startsWith(`${value}/`))
      .forEach((item) => this.files.delete(item))
    ;[...this.directories]
      .filter((item) => item === value || item.startsWith(`${value}/`))
      .forEach((item) => this.directories.delete(item))
  }

  private move(source: string, destination: string) {
    this.mkdir(path.posix.dirname(destination))
    ;[...this.files]
      .filter(([item]) => item.startsWith(`${source}/`))
      .forEach(([item, content]) => {
        this.files.set(destination + item.slice(source.length), content)
        this.files.delete(item)
      })
    ;[...this.directories]
      .filter((item) => item === source || item.startsWith(`${source}/`))
      .forEach((item) => {
        this.directories.add(destination + item.slice(source.length))
        this.directories.delete(item)
      })
  }
}
