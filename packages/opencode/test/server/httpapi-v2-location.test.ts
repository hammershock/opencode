import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Context, Schema } from "effect"
import fs from "fs/promises"
import path from "path"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir } from "../fixture/fixture"

const context = Context.empty() as Context.Context<unknown>

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  if (init.body) headers.set("content-type", "application/json")
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const Event = Schema.Struct({
  id: EventV2.ID,
  type: Schema.String,
  location: Schema.optional(Location.Ref),
  data: Schema.Unknown,
})

async function* eventStream(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    while (true) {
      const boundary = buffer.match(/(?:\r\n|\r|\n){2}/)
      if (!boundary || boundary.index === undefined) {
        const value = await reader.read()
        if (value.done) return
        buffer += decoder.decode(value.value, { stream: true })
        continue
      }

      const record = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = record
        .split(/\r\n|\r|\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
      if (data.length) yield Schema.decodeUnknownSync(Event)(JSON.parse(data.join("\n")))
    }
  } finally {
    try {
      await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function readEvent(reader: AsyncIterator<typeof Event.Type>) {
  const value = await reader.next()
  if (value.done) throw new Error("event stream closed")
  return value.value
}

async function readEventType(reader: AsyncIterator<typeof Event.Type>, type: string) {
  for (let index = 0; index < 20; index++) {
    const event = await readEvent(reader)
    if (event.type === type) return event
  }
  throw new Error(`timed out waiting for ${type}`)
}

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 location HttpApi", () => {
  test("decodes EventV2 location refs without resolved project metadata", () => {
    expect(
      Schema.decodeUnknownSync(Event)({
        id: "evt_test",
        type: "file.watcher.updated",
        location: { directory: "/tmp/project" },
        data: {},
      }),
    ).toMatchObject({ location: { directory: "/tmp/project" } })
  })

  test("returns command and skill snapshots with resolved locations", async () => {
    await using tmp = await tmpdir({ git: true })

    for (const route of ["/api/command", "/api/skill"]) {
      const response = await request(route, tmp.path)
      expect(response.status).toBe(200)
      const body = (await response.json()) as {
        location: { directory: string; project: { id: string } }
        data: unknown
      }
      expect(body.data).toBeArray()
      expect(body.location.directory).toBe(tmp.path)
      expect(body.location.project.id).toBeTruthy()
    }
  })

  test("completes User Shell input at a Location without creating a Session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "shell-completion-marker"), "")
    expect(await (await request("/session", tmp.path)).json()).toEqual([])

    const response = await request("/api/shell/completion", tmp.path, {
      method: "POST",
      body: JSON.stringify({ input: "shell-comp", cursor: 10 }),
    })

    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({
      stale: false,
      candidates: [
        expect.objectContaining({
          value: "shell-completion-marker",
          replacement: { start: 0, end: 10 },
          kind: "file",
        }),
      ],
    })
    expect(await (await request("/session", tmp.path)).json()).toEqual([])
  })

  test("runs environment init through the production Session workflow adapter", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await request("/session", tmp.path, { method: "POST" })
    expect(created.status).toBe(200)
    const session = (await created.json()) as { id: string }

    const response = await request(`/api/session/${session.id}/environment/init`, tmp.path, { method: "POST" })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      location: { directory: tmp.path },
      data: { status: "failed", template: "created" },
    })
    expect(await Bun.file(`${tmp.path}/.env`).text()).toStartWith("# Project environment variables for OpenCode.")
  })

  test("reloads Skill catalog context only on activation and retains the last good snapshot", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, skills: { paths: ["./external-skills"] } },
    })
    const root = path.join(tmp.path, "external-skills")
    const skillFile = path.join(root, "activation-review", "SKILL.md")
    await fs.mkdir(path.dirname(skillFile), { recursive: true })
    await fs.writeFile(
      skillFile,
      "---\nname: activation-review\ndescription: Review the first catalog\n---\nPRIVATE ACTIVATION BODY",
    )

    const created = await request("/api/session", tmp.path, {
      method: "POST",
      body: JSON.stringify({ location: { target: { type: "local" }, directory: tmp.path } }),
    })
    expect(created.status, await created.clone().text()).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const activate = async () => {
      const response = await request(`/api/session/${sessionID}/activate`, tmp.path, { method: "POST" })
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as {
        data: {
          status: string
          diagnostics: Array<{ kind: string; severity: string; sourceLabel: string }>
        }
      }
    }
    const modelContext = async () => {
      const response = await request(`/api/session/${sessionID}/model-context`, tmp.path)
      expect(response.status, await response.clone().text()).toBe(200)
      return (await response.json()) as {
        data: {
          generation: number
          locationRevision: number
          baseline: string
          sources: Record<string, { value: unknown; refresh?: string }>
        }
      }
    }
    const advances = async () => {
      const response = await request(`/api/session/${sessionID}/history?limit=100`, tmp.path)
      expect(response.status, await response.clone().text()).toBe(200)
      const body = (await response.json()) as { data: Array<{ data: { cause?: string } }> }
      return body.data.filter((event) => event.data.cause === "skill-catalog-reloaded")
    }

    expect(await activate()).toMatchObject({ data: { status: "initialized" } })
    const initial = (await modelContext()).data
    const initialSkillSource = initial.sources["core/skill-guidance"]
    expect(initialSkillSource).toMatchObject({
      refresh: "activation",
      value: {
        enabled: true,
        skills: expect.arrayContaining([
          expect.objectContaining({ name: "activation-review", description: "Review the first catalog" }),
        ]),
      },
    })
    expect(JSON.stringify(initialSkillSource)).not.toContain("PRIVATE ACTIVATION BODY")
    expect(JSON.stringify(initialSkillSource)).not.toContain("skl_")
    expect(await activate()).toMatchObject({ data: { status: "unchanged" } })
    expect(await advances()).toHaveLength(0)

    await fs.writeFile(
      skillFile,
      "---\nname: activation-review\ndescription: Review the second catalog\n---\nCHANGED PRIVATE BODY",
    )
    expect((await modelContext()).data.sources["core/skill-guidance"]).toEqual(initialSkillSource)
    expect(await activate()).toMatchObject({ data: { status: "advanced" } })
    const advanced = (await modelContext()).data
    expect(advanced).toMatchObject({
      generation: initial.generation,
      locationRevision: initial.locationRevision,
      baseline: initial.baseline,
    })
    expect(advanced.sources["core/skill-guidance"]).toMatchObject({
      value: {
        skills: expect.arrayContaining([
          expect.objectContaining({ name: "activation-review", description: "Review the second catalog" }),
        ]),
      },
    })
    expect(await advances()).toHaveLength(1)

    await fs.rename(root, `${root}-offline`)
    expect(await activate()).toMatchObject({
      data: {
        status: "retained",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ kind: "root-unavailable", sourceLabel: "Imported" }),
        ]),
      },
    })
    expect((await modelContext()).data.sources["core/skill-guidance"]).toEqual(advanced.sources["core/skill-guidance"])
    expect(await advances()).toHaveLength(1)
  })

  test("streams native EventV2 payloads across locations", async () => {
    await using subscriber = await tmpdir({ git: true })
    await using publisher = await tmpdir({ git: true })
    const response = await request("/api/event", subscriber.path)
    const reader = eventStream(response.body!)
    const connected = await readEvent(reader)
    expect(connected.type).toBe("server.connected")
    expect(connected.location).toBeUndefined()

    const created = await request("/session", publisher.path, { method: "POST" })
    expect(created.status).toBe(200)
    expect(await readEventType(reader, "session.created")).toMatchObject({
      type: "session.created",
      location: { directory: publisher.path },
      data: { sessionID: expect.any(String) },
    })
    await reader.return(undefined)
  })
})
