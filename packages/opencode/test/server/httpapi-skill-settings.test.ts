import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "@opencode-ai/core/global"
import { Context } from "effect"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>
const configFile = path.join(Global.Path.config, "opencode.jsonc")

function request(route: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (init.body) headers.set("content-type", "application/json")
  return HttpApiApp.webHandler().handler(new Request(`http://localhost${route}`, { ...init, headers }), context)
}

afterEach(async () => {
  await fs.rm(configFile, { force: true })
})

describe("Skill settings HttpApi", () => {
  test("updates, scopes, reloads, and resets device-local Skill settings with CAS", async () => {
    await using tmp = await tmpdir({ git: true })
    const workspace = tmp.path
    const imported = path.join(workspace, "imported")
    const packageFile = path.join(imported, "review", "SKILL.md")
    await fs.mkdir(path.dirname(packageFile), { recursive: true })
    await fs.mkdir(Global.Path.config, { recursive: true })
    await fs.writeFile(
      packageFile,
      "---\nname: review\ndescription: Review changes through the API\n---\nReview carefully.",
    )
    await fs.writeFile(configFile, '{\n  // preserve me\n  "future": true\n}\n')

    const initialResponse = await request("/api/skill/settings")
    expect(initialResponse.status).toBe(200)
    const initial = (await initialResponse.json()) as { revision: string; roots: Array<{ default: boolean }> }
    expect(initial.roots).toHaveLength(2)
    expect(initial.roots.every((root) => root.default)).toBe(true)

    const updateResponse = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [imported], urls: [], expectedRevision: initial.revision }),
    })
    expect(updateResponse.status).toBe(200)
    const updated = (await updateResponse.json()) as {
      revision: string
      roots: Array<{ kind: string; value: string; default: boolean }>
    }
    expect(updated.roots).toContainEqual(expect.objectContaining({ kind: "imported", value: imported, default: false }))
    expect(await fs.readFile(configFile, "utf8")).toContain("// preserve me")

    const stale = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [], urls: [], expectedRevision: initial.revision }),
    })
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ _tag: "ConflictError" })

    const location = new URLSearchParams({ "location[directory]": workspace })
    const reloadResponse = await request(`/api/skill/reload?${location}`, { method: "POST" })
    expect(reloadResponse.status).toBe(200)
    const reloaded = (await reloadResponse.json()) as { data: { skills: Array<{ id: string; name: string }> } }
    const skill = reloaded.data.skills.find((item) => item.name === "review")
    expect(skill).toBeDefined()
    expect(skill).not.toHaveProperty("content")

    const scopeResponse = await request(`/api/skill/settings/${skill!.id}/target-scope`, {
      method: "PUT",
      body: JSON.stringify({ scope: [], expectedRevision: updated.revision }),
    })
    expect(scopeResponse.status).toBe(200)
    const scoped = (await scopeResponse.json()) as { revision: string; targets: Record<string, unknown> }
    expect(scoped.targets[skill!.id]).toEqual([])

    const filtered = (await (await request(`/api/skill/catalog?${location}&forceReload=true`)).json()) as {
      data: { skills: Array<{ name: string }> }
    }
    expect(filtered.data.skills.some((item) => item.name === "review")).toBe(false)

    const management = (await (
      await request(`/api/skill/catalog?${location}&forceReload=true&includeInactive=true`)
    ).json()) as {
      data: { skills: Array<{ name: string }> }
    }
    expect(management.data.skills.some((item) => item.name === "review")).toBe(true)

    const invalidScope = await request(`/api/skill/settings/${skill!.id}/target-scope`, {
      method: "PUT",
      body: JSON.stringify({ scope: ["not-a-target"], expectedRevision: scoped.revision }),
    })
    expect(invalidScope.status).toBe(400)

    const invalidPath = await request("/api/skill/settings/discovery", {
      method: "PUT",
      body: JSON.stringify({ paths: [" invalid "], urls: [], expectedRevision: scoped.revision }),
    })
    expect(invalidPath.status).toBe(400)
    expect(await invalidPath.json()).toMatchObject({ _tag: "InvalidRequestError", kind: "skill_path" })

    const resetResponse = await request("/api/skill/settings/discovery/reset", {
      method: "POST",
      body: JSON.stringify({ expectedRevision: scoped.revision }),
    })
    expect(resetResponse.status).toBe(200)
    const reset = (await resetResponse.json()) as {
      roots: Array<{ default: boolean }>
      targets: Record<string, unknown>
    }
    expect(reset.roots.every((root) => root.default)).toBe(true)
    expect(reset.targets[skill!.id]).toEqual([])
    expect(await fs.readFile(packageFile, "utf8")).toContain("Review carefully")
  })
})
