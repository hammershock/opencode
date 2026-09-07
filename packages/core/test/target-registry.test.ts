import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "./fixture/tmpdir"
import { Location } from "../src/location"
import { TargetRegistry } from "../src/target-registry"
import { TargetWizard } from "../src/target-wizard"

const manual = (name: string): TargetRegistry.Input => ({
  name,
  transport: "ssh",
  connection: { type: "manual", host: `${name}.example`, user: "hammer", port: 22 },
  defaultDirectory: "/home/hammer/project",
  workspaceRoots: ["/home/hammer"],
})

describe("TargetRegistry", () => {
  test("uses only the injected OpenCode user config directory", async () => {
    await using root = await tmpdir()
    const user = path.join(root.path, "config", "opencode")
    const project = path.join(root.path, "project", ".opencode")
    await fs.mkdir(project, { recursive: true })
    await fs.writeFile(
      path.join(project, "targets.jsonc"),
      JSON.stringify({ version: 1, targets: { "1bad": { name: "injected" } } }),
    )
    const registry = TargetRegistry.make({ directory: user })
    const snapshot = await registry.load()
    expect(snapshot.targets).toEqual([])
    expect(snapshot.path).toBe(path.join(user, "targets.jsonc"))
  })

  test("creates stable UUID targets and preserves comments, unknown fields, and permissions", async () => {
    if (process.platform === "win32") return
    await using root = await tmpdir()
    const file = path.join(root.path, "targets.jsonc")
    await fs.writeFile(
      file,
      `{
  // owned by the user
  "version": 1,
  "future": true,
  "targets": {}
}\n`,
      { mode: 0o640 },
    )
    const registry = TargetRegistry.make({ directory: root.path })
    const initial = await registry.load()
    expect(initial.valid).toBe(true)
    expect(initial.diagnostics).toContainEqual(expect.objectContaining({ path: "$.future", severity: "warning" }))

    const created = await registry.create(manual("gpu"), initial.revision)
    expect(created.target.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.target.status).toBe("unverified")
    expect(await fs.readFile(file, "utf8")).toContain("// owned by the user")
    expect(await fs.readFile(file, "utf8")).toContain('"future": true')
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640)

    const renamed = await registry.update(created.target.id, manual("gpu-renamed"), created.snapshot.revision)
    expect(renamed.target.id).toBe(created.target.id)
    expect(renamed.snapshot.targets[0]?.name).toBe("gpu-renamed")
  })

  test("preserves nested future fields and comments while updating a connection", async () => {
    await using root = await tmpdir()
    const id = "9a858c60-01c7-4a3d-a137-f5df09560d42"
    const file = path.join(root.path, "targets.jsonc")
    await fs.writeFile(
      file,
      `{"version":1,"targets":{"${id}":{"name":"gpu","transport":"ssh","connection":{"type":"manual","host":"old","user":"hammer","port":22,// keep nested\n"futureAuth":"agent"},"workspaceRoots":["/"]}}}`,
    )
    const registry = TargetRegistry.make({ directory: root.path })
    const snapshot = await registry.load()
    expect(snapshot.valid).toBe(true)
    await registry.update(Location.TargetID.make(id), manual("renamed"), snapshot.revision)
    const text = await fs.readFile(file, "utf8")
    expect(text).toContain("// keep nested")
    expect(text).toMatch(/"futureAuth"\s*:\s*"agent"/)
    expect(text).toMatch(/"host"\s*:\s*"renamed\.example"/)
  })

  test("rejects stale revisions and same-name targets", async () => {
    await using root = await tmpdir()
    const registry = TargetRegistry.make({ directory: root.path })
    const initial = await registry.load()
    const first = await registry.create(manual("gpu"), initial.revision)
    await expect(registry.create(manual("other"), initial.revision)).rejects.toHaveProperty(
      "_tag",
      "TargetRegistry.RevisionConflictError",
    )
    await expect(registry.create(manual("gpu"), first.snapshot.revision)).rejects.toHaveProperty(
      "_tag",
      "TargetRegistry.NameConflictError",
    )
  })

  test("serializes concurrent writers so only one matching revision commits", async () => {
    await using root = await tmpdir()
    const registry = TargetRegistry.make({ directory: root.path })
    const revision = (await registry.load()).revision
    const results = await Promise.allSettled([
      registry.create(manual("one"), revision),
      registry.create(manual("two"), revision),
    ])
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((await registry.load()).targets).toHaveLength(1)
  })

  test("reports JSON paths for invalid and duplicate semantics without overwriting the file", async () => {
    await using root = await tmpdir()
    const file = path.join(root.path, "targets.jsonc")
    await fs.writeFile(
      file,
      `{"version":1,"version":1,"targets":{"not-a-uuid":{"name":"gpu","transport":"ssh","connection":{"type":"manual","host":"h","user":"u","port":"bad"},"workspaceRoots":["relative"]}}}`,
    )
    const registry = TargetRegistry.make({ directory: root.path })
    const snapshot = await registry.load()
    expect(snapshot.valid).toBe(false)
    expect(snapshot.diagnostics.map((item) => item.path)).toContain("$.version")
    expect(snapshot.diagnostics.map((item) => item.path)).toContain("$.targets.not-a-uuid")
    await expect(registry.create(manual("new"), snapshot.revision)).rejects.toHaveProperty(
      "_tag",
      "TargetRegistry.InvalidConfigError",
    )
    expect(await fs.readFile(file, "utf8")).toContain('"version":1,"version":1')
  })

  test("keeps ssh-config and manual fields mutually exclusive", async () => {
    await using root = await tmpdir()
    await fs.writeFile(
      path.join(root.path, "targets.jsonc"),
      JSON.stringify({
        version: 1,
        targets: {
          "9a858c60-01c7-4a3d-a137-f5df09560d42": {
            name: "bad",
            transport: "ssh",
            connection: { type: "ssh-config", host: "gpu", user: "must-not-overlap" },
            workspaceRoots: ["/"],
          },
        },
      }),
    )
    const snapshot = await TargetRegistry.make({ directory: root.path }).load()
    expect(snapshot.valid).toBe(false)
    expect(snapshot.diagnostics).toContainEqual(
      expect.objectContaining({ path: "$.targets.9a858c60-01c7-4a3d-a137-f5df09560d42.connection.user" }),
    )
  })

  test("removal only changes the registry and restoration requires an explicit affected Session batch", async () => {
    await using root = await tmpdir()
    const registry = TargetRegistry.make({
      directory: root.path,
      restoreAuthorizer: { authorize: async (_targetID, sessions) => sessions.includes("session-one") },
    })
    const created = await registry.create(manual("gpu"), (await registry.load()).revision)
    const removed = await registry.remove(created.target.id, created.snapshot.revision)
    expect(removed.targets).toEqual([])
    await expect(
      registry.restoreMissing(created.target.id, manual("gpu"), [], removed.revision),
    ).rejects.toHaveProperty("_tag", "TargetRegistry.RestoreAuthorizationError")
    await expect(
      registry.restoreMissing(created.target.id, manual("gpu"), ["fabricated"], removed.revision),
    ).rejects.toHaveProperty("_tag", "TargetRegistry.RestoreAuthorizationError")
    const restored = await registry.restoreMissing(
      created.target.id,
      manual("gpu"),
      ["session-one", "session-two"],
      removed.revision,
    )
    expect(restored.target.id).toBe(created.target.id)
  })

  test("delegates test and prepare to a typed transport boundary", async () => {
    await using root = await tmpdir()
    const calls: string[] = []
    const registry = TargetRegistry.make({
      directory: root.path,
      probe: {
        test: async (target) => {
          calls.push(`test:${target.name}`)
          return { status: "ready", stages: ["ssh", "handshake"] }
        },
        prepare: async (target, directory) => {
          calls.push(`prepare:${target.name}:${directory}`)
          return { status: "ready", stages: ["ssh", "environment", "prepare", "handshake"] }
        },
        inspect: async (target) => {
          calls.push(`inspect:${target.name}`)
          return { home: "/home/remote" }
        },
        complete: async (target, input) => {
          calls.push(`complete:${target.name}:${input.value}`)
          return { value: "/home/remote/", cursor: 13, candidates: ["/home/remote/"] }
        },
      },
    })
    const created = await registry.create(manual("gpu"), (await registry.load()).revision)
    expect(await registry.testConnection(created.target.id)).toMatchObject({ status: "ready" })
    expect(await registry.prepare(created.target.id, "/historical/worktree")).toMatchObject({ status: "ready" })
    expect(await registry.inspect(manual("draft"))).toEqual({ home: "/home/remote" })
    expect(await registry.complete(manual("draft"), { value: "/ho", cursor: 3, cwd: "/" })).toEqual({
      value: "/home/remote/",
      cursor: 13,
      candidates: ["/home/remote/"],
    })
    expect(calls).toEqual(["test:gpu", "prepare:gpu:/historical/worktree", "inspect:draft", "complete:draft:/ho"])
  })

  test("previews and explicitly imports legacy config without changing the source", async () => {
    await using root = await tmpdir()
    const legacy = path.join(root.path, "legacy-targets.json")
    const original = JSON.stringify({
      targets: {
        gpu: {
          transport: "ssh",
          host: "gpu-alias",
          defaultCwd: "/data/project",
          workspaceRoots: ["/data"],
          command: "rexd serve --stdio",
        },
      },
    })
    await fs.writeFile(legacy, original)
    const registry = TargetRegistry.make({ directory: path.join(root.path, "new"), legacyFile: legacy })
    const preview = await registry.previewLegacyImport()
    expect(preview.candidates).toHaveLength(1)
    expect(preview.candidates[0]?.connection).toEqual({ type: "ssh-config", host: "gpu-alias" })
    expect(preview.diagnostics).toContainEqual(expect.objectContaining({ path: "$.targets.gpu.command" }))
    const imported = await registry.importLegacy(preview.sourceRevision, (await registry.load()).revision)
    expect(imported.snapshot.targets[0]?.name).toBe("gpu")
    expect(await fs.readFile(legacy, "utf8")).toBe(original)
  })

  test("rejects a legacy preview if its source changed before confirmation", async () => {
    await using root = await tmpdir()
    const legacy = path.join(root.path, "legacy-targets.json")
    await fs.writeFile(legacy, JSON.stringify({ targets: {} }))
    const registry = TargetRegistry.make({ directory: path.join(root.path, "new"), legacyFile: legacy })
    const preview = await registry.previewLegacyImport()
    await fs.writeFile(legacy, JSON.stringify({ targets: { changed: {} } }))
    await expect(
      registry.importLegacy(preview.sourceRevision, (await registry.load()).revision),
    ).rejects.toHaveProperty("_tag", "TargetRegistry.RevisionConflictError")
  })
})

describe("TargetWizard", () => {
  test("models create steps, immutable identity, host-key acknowledgement, and unverified save", () => {
    const started = TargetWizard.create()
    const id = started.draft.id
    const named = TargetWizard.next(TargetWizard.update(started, { name: "gpu" }))
    expect(named.step).toBe("connection")
    const connected = TargetWizard.next(
      TargetWizard.update(named, { connection: { type: "ssh-config", host: "gpu-alias" } }),
    )
    const workspace = TargetWizard.next(
      TargetWizard.update(connected, { workspaceRoots: ["/data"], defaultDirectory: "/data/project" }),
    )
    const blocked = TargetWizard.next(workspace)
    expect(blocked.step).toBe("host-key")
    expect(TargetWizard.next(blocked).step).toBe("host-key")
    const verification = TargetWizard.next(TargetWizard.update(blocked, { hostKeyPolicyAcknowledged: true }))
    const reviewed = TargetWizard.next(
      TargetWizard.update(verification, {
        verification: { status: "unavailable", stage: "ssh", message: "offline" },
      }),
    )
    expect(reviewed.step).toBe("review")
    expect(reviewed.draft.id).toBe(id)
    expect(TargetWizard.input(reviewed)?.name).toBe("gpu")
    expect(TargetWizard.confirmUnverified(reviewed)).toBe(reviewed)
  })

  test("edit retains target identity", () => {
    const id = Location.TargetID.make("bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9")
    expect(TargetWizard.edit({ id, status: "unverified", ...manual("gpu") }).draft.id).toBe(id)
  })
})
