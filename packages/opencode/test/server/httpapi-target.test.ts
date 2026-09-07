import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"

const context = Context.empty() as Context.Context<unknown>
const file = path.join(Global.Path.config, "targets.jsonc")
const bindingFile = path.join(Global.Path.config, "target-bindings.json")

function request(route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set("content-type", "application/json")
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

const input = {
  name: "gpu",
  transport: "ssh",
  connection: { type: "ssh-config", host: "gpu-alias" },
  defaultDirectory: "/data/project",
  workspaceRoots: ["/data"],
} as const

afterEach(async () => {
  await fs.rm(file, { force: true })
  await fs.rm(bindingFile, { force: true })
})

describe("target registry HttpApi", () => {
  test("exposes CRUD with revision conflicts and no project-location header", async () => {
    const listed = await request("/api/target")
    expect(listed.status).toBe(200)
    const initial = (await listed.json()) as { revision: string; targets: unknown[] }
    expect(initial.targets).toEqual([])

    const createdResponse = await request("/api/target", {
      method: "POST",
      body: JSON.stringify({ input, expectedRevision: initial.revision }),
    })
    expect(createdResponse.status).toBe(200)
    const created = (await createdResponse.json()) as {
      target: { id: string; name: string; connection: { type: string } }
      snapshot: { revision: string }
    }
    expect(created.target).toMatchObject({ name: "gpu", connection: { type: "ssh-config" } })

    const stale = await request("/api/target", {
      method: "POST",
      body: JSON.stringify({ input: { ...input, name: "other" }, expectedRevision: initial.revision }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ _tag: "ConflictError", resource: "targets.jsonc" })

    const removed = await request(`/api/target/${created.target.id}`, {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: created.snapshot.revision }),
    })
    expect(removed.status).toBe(200)
    expect(await removed.json()).toMatchObject({ targets: [] })
  })

  test("maps missing, unauthorized restore, and unavailable transport without leaking credentials", async () => {
    const initial = (await (await request("/api/target")).json()) as { revision: string }
    const created = (await (
      await request("/api/target", {
        method: "POST",
        body: JSON.stringify({ input, expectedRevision: initial.revision }),
      })
    ).json()) as { target: { id: string }; snapshot: { revision: string } }

    const probe = await request(`/api/target/${created.target.id}/test`, { method: "POST" })
    expect(probe.status).toBe(200)
    expect(await probe.json()).toMatchObject({ status: "unavailable", stage: "ssh" })

    const restore = await request(`/api/target/${crypto.randomUUID()}/restore`, {
      method: "POST",
      body: JSON.stringify({
        input,
        referencedSessionIDs: ["fabricated"],
        expectedRevision: created.snapshot.revision,
      }),
    })
    expect(restore.status).toBe(403)
    expect(await restore.json()).toMatchObject({ _tag: "ForbiddenError" })

    const missing = await request(`/api/target/${crypto.randomUUID()}/test`, { method: "POST" })
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "TargetNotFoundError" })
  })

  test("requires explicit confirmation token for legacy import", async () => {
    const preview = await request("/api/target/legacy/import")
    expect(preview.status).toBe(200)
    expect(await preview.json()).toMatchObject({ candidates: [], diagnostics: [] })
  })

  test("exposes an empty device-local portable binding registry", async () => {
    const response = await request("/api/target-binding")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ bindings: {} })
  })

  test("unbinds through the canonical registry only when revision and affected Session snapshot match", async () => {
    await fs.mkdir(path.dirname(bindingFile), { recursive: true })
    await fs.writeFile(bindingFile, JSON.stringify({ version: 1, bindings: { "lab-gpu": crypto.randomUUID() } }))
    const listed = (await (await request("/api/target-binding")).json()) as { revision: string }

    const changedScope = await request("/api/target-binding/lab-gpu", {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: listed.revision, expectedSessionIDs: ["ses_fabricated"] }),
    })
    expect(changedScope.status).toBe(409)
    expect(await changedScope.json()).toMatchObject({ _tag: "ConflictError", resource: "lab-gpu" })

    const removed = await request("/api/target-binding/lab-gpu", {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: listed.revision, expectedSessionIDs: [] }),
    })
    expect(removed.status).toBe(200)
    const snapshot = (await removed.json()) as { revision: string; bindings: Record<string, string> }
    expect(snapshot.bindings).toEqual({})

    const stale = await request("/api/target-binding/lab-gpu", {
      method: "DELETE",
      body: JSON.stringify({ expectedRevision: listed.revision, expectedSessionIDs: [] }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ _tag: "ConflictError", resource: "target-bindings.json" })
  })
})
