import { expect, test } from "bun:test"
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import fs from "node:fs/promises"
import path from "node:path"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { AbsolutePath, RelativePath } from "@opencode-ai/core/schema"
import { Hash } from "@opencode-ai/core/util/hash"
import { Skill } from "@opencode-ai/schema/skill"
import { connectRexd } from "../../src/rexd/connection"
import { RexdError } from "../../src/rexd/error"
import { RexdSkillMaterializer } from "../../src/rexd/skill-materializer"
import type { Transport } from "../../src/rexd/ssh"
import { tmpdir } from "../fixture/fixture"

const binary = process.env.OPENCODE_REXD_ACCEPTANCE_BINARY
const acceptance = binary ? test : test.skip

acceptance("materializes and reclaims a binary package through the pinned Rexd process", async () => {
  await using temporary = await tmpdir()
  const staging = path.join(temporary.path, "skills")
  const config = path.join(temporary.path, "rexd.toml")
  await fs.writeFile(
    config,
    `[server]
stdio = true
http_listen = ""
log_level = "error"

[limits]
default_timeout_ms = 30000
hard_timeout_ms = 300000
max_output_bytes = 1048576
max_file_read_bytes = 1048576
max_processes_per_session = 8
max_concurrent_sessions = 16

[security]
allow_shell = true

[[security.allowed_roots]]
path = ${JSON.stringify(staging)}

[audit]
enabled = false
`,
  )
  const lease = await connectRexd(
    {
      id: "acceptance",
      connection: { type: "ssh-config", host: "unused" },
      workspaceRoots: [temporary.path],
      command: { program: binary!, args: ["--stdio", "--config", config] },
      skillStagingRoot: staging,
    },
    { clientVersion: "acceptance" },
    { connect: () => new ProcessTransport(binary!, ["--stdio", "--config", config]) },
  )
  const content = Buffer.concat([Buffer.alloc(SkillPackageSnapshot.READ_CHUNK_BYTES, 7), Buffer.from([0, 255])])
  const file = {
    path: RelativePath.make("assets/data.bin"),
    size: content.length,
    digest: Skill.Digest.make(Hash.sha256(content)),
    content,
  }
  const snapshot: SkillPackageSnapshot.Snapshot = {
    skillID: Skill.ID.make(`skl_${"1".repeat(64)}`),
    root: AbsolutePath.make("/controller/skill"),
    files: [file],
    size: file.size,
    digest: Skill.Digest.make(Hash.sha256(JSON.stringify([[file.path, file.size, file.digest]]))),
  }
  const materializer = new RexdSkillMaterializer.Materializer("acceptance", lease, "app")
  const attachment = await materializer.materialize(snapshot, "session")

  expect(await fs.readFile(path.join(attachment.path, file.path))).toEqual(content)
  await attachment.release()
  expect(await fs.stat(attachment.path).catch(() => undefined)).toBeUndefined()
  await materializer.close()
  await lease.close()
})

class ProcessTransport implements Transport {
  readonly #data = new Set<(chunk: string) => void>()
  readonly #close = new Set<(error: RexdError) => void>()
  readonly #child: ChildProcessWithoutNullStreams
  #closed = false

  constructor(program: string, args: readonly string[]) {
    this.#child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] })
    this.#child.stdout.setEncoding("utf8")
    this.#child.stdout.on("data", (chunk: string) => this.#data.forEach((listener) => listener(chunk)))
    this.#child.once("close", (code) => {
      if (this.#closed) return
      this.#closed = true
      this.#close.forEach((listener) =>
        listener(new RexdError("transport", `Acceptance Rexd closed (${code ?? "unknown"})`, true)),
      )
    })
  }

  write(payload: string) {
    return new Promise<void>((resolve, reject) =>
      this.#child.stdin.write(payload, (error) => (error ? reject(error) : resolve())),
    )
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
    this.#child.stdin.end()
    if (this.#child.exitCode !== null) return
    await new Promise<void>((resolve) => this.#child.once("close", () => resolve()))
  }
}
