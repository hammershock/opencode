import { afterEach, describe, expect, test } from "bun:test"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { Skill } from "@opencode-ai/schema/skill"
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

  test("keeps the legacy Skill list equal to the canonical catalog projection", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, skills: { paths: ["./explicit-skills"] } },
    })
    await Bun.write(
      path.join(tmp.path, "explicit-skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Review a patch\n---\n\n# Review\n",
    )

    const legacy = await request("/skill", tmp.path)
    const canonical = await request("/api/skill", tmp.path)
    expect(legacy.status, await legacy.clone().text()).toBe(200)
    expect(canonical.status, await canonical.clone().text()).toBe(200)
    const legacyData = (await legacy.json()) as Array<{ name: string }>
    expect(legacyData.some((item) => item.name === "review")).toBe(true)
    expect(legacyData).toEqual(((await canonical.json()) as { data: Array<{ name: string }> }).data)
  })

  test("previews the canonical Skill catalog through the selected Agent without creating a Session", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: {
        formatter: false,
        lsp: false,
        skills: { paths: ["./preview-skills"] },
        agent: {
          unrestricted: {},
          restricted: { permission: { skill: { review: "deny" } } },
        },
      },
    })
    await Promise.all(
      (
        [
          ["review", "Review a patch"],
          ["verify", "Verify a patch"],
        ] as const
      ).map(async ([name, description]) => {
        const directory = path.join(tmp.path, "preview-skills", name)
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${description}\n---\nBody`,
        )
      }),
    )
    const catalog = async (agent?: string) => {
      const response = await request(`/api/skill/catalog${agent ? `?agent=${agent}` : ""}`, tmp.path)
      expect(response.status, await response.clone().text()).toBe(200)
      return ((await response.json()) as { data: Skill.RegistrySnapshot }).data
    }

    expect(await (await request("/api/session", tmp.path)).json()).toMatchObject({ data: [] })
    const complete = await catalog()
    const expected = complete.skills.filter((skill) => ["review", "verify"].includes(skill.name))
    expect(expected).toHaveLength(2)
    expect((await catalog("unrestricted")).skills).toEqual(complete.skills)
    expect((await catalog("restricted")).skills.filter((skill) => ["review", "verify"].includes(skill.name))).toEqual(
      expected.filter((skill) => skill.name === "verify"),
    )
    expect((await catalog("missing-agent")).skills).toEqual([])
    expect(await (await request("/api/session", tmp.path)).json()).toMatchObject({ data: [] })
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

  test("bounds model Skill guidance without trimming the device-local catalog", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, skills: { paths: ["./many-skills"] } },
    })
    await Promise.all(
      Array.from({ length: 70 }, async (_, index) => {
        const name = `bounded-${index.toString().padStart(3, "0")}`
        const directory = path.join(tmp.path, "many-skills", name)
        await fs.mkdir(directory, { recursive: true })
        await fs.writeFile(
          path.join(directory, "SKILL.md"),
          `---\nname: ${name}\ndescription: ${"界".repeat(Skill.MAX_DESCRIPTION_CHARACTERS)}\n---\nBody`,
        )
      }),
    )

    const created = await request("/api/session", tmp.path, {
      method: "POST",
      body: JSON.stringify({ location: { target: { type: "local" }, directory: tmp.path } }),
    })
    expect(created.status, await created.clone().text()).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const activated = await request(`/api/session/${sessionID}/activate`, tmp.path, { method: "POST" })
    expect(activated.status, await activated.clone().text()).toBe(200)

    const localResponse = await request("/api/skill/catalog", tmp.path)
    expect(localResponse.status, await localResponse.clone().text()).toBe(200)
    const local = (await localResponse.json()) as { data: { skills: Array<{ name: string; description?: string }> } }
    expect(local.data.skills.filter((skill) => skill.name.startsWith("bounded-"))).toHaveLength(70)
    expect(
      local.data.skills
        .filter((skill) => skill.name.startsWith("bounded-"))
        .every((skill) => [...(skill.description ?? "")].length === Skill.MAX_DESCRIPTION_CHARACTERS),
    ).toBe(true)

    const contextResponse = await request(`/api/session/${sessionID}/model-context`, tmp.path)
    expect(contextResponse.status, await contextResponse.clone().text()).toBe(200)
    const context = (await contextResponse.json()) as {
      data: {
        sources: Record<
          string,
          { baseline: string; value: { skills: Array<{ name: string; description?: string }>; omitted?: number } }
        >
      }
    }
    const guidance = context.data.sources["core/skill-guidance"]!
    expect(new TextEncoder().encode(guidance.baseline).byteLength).toBeLessThanOrEqual(Skill.MAX_GUIDANCE_BYTES)
    expect(guidance.value.skills.length).toBeLessThanOrEqual(Skill.MAX_GUIDANCE_ENTRIES)
    expect(guidance.value.omitted).toBe(local.data.skills.length - guidance.value.skills.length)
    expect(guidance.baseline).toContain(`<omitted count="${guidance.value.omitted}">`)
  })

  test("admits portable Skill snapshots atomically and reuses them for exact retries", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, skills: { paths: ["./explicit-skills"] } },
    })
    const skillFile = path.join(tmp.path, "explicit-skills", "review", "SKILL.md")
    await fs.mkdir(path.dirname(skillFile), { recursive: true })
    await fs.writeFile(
      skillFile,
      "---\nname: review\ndescription: Review a patch\n---\nKeep $ARGUMENTS and $1 literal.",
    )

    const created = await request("/api/session", tmp.path, {
      method: "POST",
      body: JSON.stringify({ location: { target: { type: "local" }, directory: tmp.path } }),
    })
    expect(created.status, await created.clone().text()).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const activated = await request(`/api/session/${sessionID}/activate`, tmp.path, { method: "POST" })
    expect(activated.status, await activated.clone().text()).toBe(200)

    const catalogResponse = await request("/api/skill/catalog?forceReload=false", tmp.path)
    expect(catalogResponse.status, await catalogResponse.clone().text()).toBe(200)
    const catalog = (await catalogResponse.json()) as {
      data: { skills: Array<{ id: string; name: string }> }
    }
    const skill = catalog.data.skills.find((item) => item.name === "review")!
    const prompt = {
      text: "$review $review inspect the patch",
      skills: [
        { id: skill.id, name: skill.name, source: { start: 0, end: 7, text: "$review" } },
        { id: skill.id, name: skill.name, source: { start: 8, end: 15, text: "$review" } },
      ],
    }
    const admit = (id: string, value = prompt) =>
      request(`/api/session/${sessionID}/prompt`, tmp.path, {
        method: "POST",
        body: JSON.stringify({ id, prompt: value, resume: false }),
      })

    const [first, concurrent] = await Promise.all([admit("msg_skill_snapshot"), admit("msg_skill_snapshot")])
    expect(first.status, await first.clone().text()).toBe(200)
    expect(concurrent.status, await concurrent.clone().text()).toBe(200)
    const admitted = (await first.json()) as {
      data: {
        prompt: {
          text: string
          invocations: Array<{
            source: { start: number; end: number; text: string }
            snapshot: { id: string; name: string; digest: string; source: { label: string }; content: string }
          }>
        }
      }
    }
    expect(admitted.data.prompt.text).toBe(prompt.text)
    expect(admitted.data.prompt.invocations).toHaveLength(1)
    const skillContent = [
      "# Skill: review",
      "",
      "Keep $ARGUMENTS and $1 literal.",
      "",
      `Package directory: ${path.join(tmp.path, "explicit-skills", "review")}`,
      "Relative paths in this Skill are relative to this directory.",
      "Use the ordinary filesystem and shell tools to read, modify, or execute files in this directory.",
    ].join("\n")
    expect(admitted.data.prompt.invocations[0]).toMatchObject({
      source: prompt.skills[0]!.source,
      snapshot: {
        id: expect.stringMatching(/^ski_/),
        name: "review",
        source: { label: "Imported" },
        content: skillContent,
      },
    })
    expect(JSON.stringify(admitted)).not.toContain("skl_")
    expect(await concurrent.json()).toEqual(admitted)

    await fs.writeFile(skillFile, "---\nname: review\ndescription: Review a patch\n---\nChanged body")
    await disposeAllInstances()
    const retried = await admit("msg_skill_snapshot")
    expect(retried.status, await retried.clone().text()).toBe(200)
    expect(await retried.json()).toEqual(admitted)

    const stale = await admit("msg_skill_stale")
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ _tag: "SkillMentionError", kind: "stale-catalog", name: "review" })

    await fs.unlink(skillFile)
    const missing = await admit("msg_skill_missing")
    expect(missing.status).toBe(400)
    expect(await missing.json()).toMatchObject({ _tag: "SkillMentionError", kind: "unavailable", name: "review" })

    const invalid = await admit("msg_skill_invalid", {
      text: "$review inspect",
      skills: [{ id: skill.id, name: skill.name, source: { start: 1, end: 7, text: "$review" } }],
    })
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toMatchObject({ _tag: "SkillMentionError", kind: "invalid-mention", name: "review" })

    const history = await request(`/api/session/${sessionID}/history?limit=100`, tmp.path)
    const events = (await history.json()) as { data: Array<{ type: string }> }
    expect(events.data.filter((event) => event.type === "session.next.prompt.admitted")).toHaveLength(1)
  })

  test("keeps exact admitted Skill identities device-local when portable metadata collides", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, skills: { paths: ["./skills-one", "./skills-two"] } },
    })
    const content = "---\nname: review\ndescription: Review a patch\n---\nSame portable Skill body"
    await fs.mkdir(path.join(tmp.path, "skills-one", "review"), { recursive: true })
    await fs.mkdir(path.join(tmp.path, "skills-two", "review"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "skills-one", "review", "SKILL.md"), content)
    await fs.writeFile(path.join(tmp.path, "skills-two", "review", "SKILL.md"), content)

    const created = await request("/api/session", tmp.path, {
      method: "POST",
      body: JSON.stringify({ location: { target: { type: "local" }, directory: tmp.path } }),
    })
    expect(created.status, await created.clone().text()).toBe(200)
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const activated = await request(`/api/session/${sessionID}/activate`, tmp.path, { method: "POST" })
    expect(activated.status, await activated.clone().text()).toBe(200)

    const currentResponse = await request("/api/skill/catalog", tmp.path)
    expect(currentResponse.status, await currentResponse.clone().text()).toBe(200)
    const current = (await currentResponse.json()) as {
      data: { skills: Array<{ id: string; name: string; digest: string; sourceLabel: string }> }
    }
    const collisions = current.data.skills.filter((skill) => skill.name === "review")
    expect(collisions).toHaveLength(2)
    expect(new Set(collisions.map((skill) => skill.digest)).size).toBe(1)
    expect(new Set(collisions.map((skill) => skill.sourceLabel.replace(/ · [0-9a-f]{8}$/i, "")))).toEqual(
      new Set(["Imported"]),
    )

    const contextResponse = await request(`/api/session/${sessionID}/model-context`, tmp.path)
    expect(contextResponse.status, await contextResponse.clone().text()).toBe(200)
    const context = (await contextResponse.json()) as {
      data: unknown
      skillCatalog: { skills: Array<{ id: string; name: string }> }
    }
    expect(
      context.skillCatalog.skills
        .filter((skill) => skill.name === "review")
        .map((skill) => skill.id)
        .toSorted(),
    ).toEqual(collisions.map((skill) => skill.id).toSorted())
    expect(JSON.stringify(context.data)).not.toContain("skl_")

    const admitted = await request(`/api/session/${sessionID}/prompt`, tmp.path, {
      method: "POST",
      body: JSON.stringify({
        id: "msg_skill_identity_collision",
        prompt: {
          text: "$review $review",
          skills: [
            { id: collisions[0]!.id, name: "review", source: { start: 0, end: 7, text: "$review" } },
            { id: collisions[1]!.id, name: "review", source: { start: 8, end: 15, text: "$review" } },
          ],
        },
        resume: false,
      }),
    })
    expect(admitted.status, await admitted.clone().text()).toBe(200)
    const admittedBody = await admitted.json()
    expect(JSON.stringify(admittedBody)).not.toContain("skl_")
    expect((admittedBody as { data: { prompt: { invocations: unknown[] } } }).data.prompt.invocations).toHaveLength(2)

    const history = await request(`/api/session/${sessionID}/history?limit=100`, tmp.path)
    expect(history.status, await history.clone().text()).toBe(200)
    expect(JSON.stringify(await history.json())).not.toContain("skl_")
  })

  test("adapts legacy Skill slash commands to canonical durable admission", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { formatter: false, lsp: false, skills: { paths: ["./explicit-skills"] } },
    })
    const skillFile = path.join(tmp.path, "explicit-skills", "slash-review", "SKILL.md")
    await fs.mkdir(path.dirname(skillFile), { recursive: true })
    await fs.writeFile(
      skillFile,
      "---\nname: slash-review\ndescription: Review through slash compatibility\n---\nKeep $ARGUMENTS and $1 literal.",
    )
    await fs.mkdir(path.join(tmp.path, "explicit-skills", "review"), { recursive: true })
    await fs.writeFile(
      path.join(tmp.path, "explicit-skills", "review", "SKILL.md"),
      "---\nname: review\ndescription: Must not shadow the built-in command\n---\nCOLLIDING SKILL BODY",
    )

    const commands = await request("/command", tmp.path)
    expect(commands.status, await commands.clone().text()).toBe(200)
    const commandList = (await commands.json()) as Array<{ name: string; source: string; template: string }>
    expect(commandList).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "slash-review", source: "skill", template: "", hints: [] }),
      ]),
    )
    expect(commandList.filter((command) => command.name === "review")).toEqual([
      expect.objectContaining({ name: "review", source: "command" }),
    ])

    const created = await request("/api/session", tmp.path, {
      method: "POST",
      body: JSON.stringify({
        agent: "build",
        model: { providerID: "unknown", id: "unknown" },
        location: { target: { type: "local" }, directory: tmp.path },
      }),
    })
    const sessionID = ((await created.json()) as { data: { id: string } }).data.id
    const activated = await request(`/api/session/${sessionID}/activate`, tmp.path, { method: "POST" })
    expect(activated.status, await activated.clone().text()).toBe(200)
    const invoke = (messageID: string) =>
      request(`/session/${sessionID}/command`, tmp.path, {
        method: "POST",
        body: JSON.stringify({
          messageID,
          command: "slash-review",
          arguments: "inspect $ARGUMENTS and $1",
          agent: "build",
          model: "unknown/unknown",
        }),
      })

    const first = await invoke("msg_slash_compatibility")
    expect(first.status, await first.clone().text()).toBe(200)
    const response = (await first.json()) as { parts: Array<{ type: string; text?: string }> }
    expect(response.parts).toEqual([
      expect.objectContaining({ type: "text", text: "$slash-review inspect $ARGUMENTS and $1" }),
    ])
    expect(JSON.stringify(response)).not.toContain("Keep $ARGUMENTS")

    const catalogResponse = await request("/api/skill/catalog?forceReload=false", tmp.path)
    const catalog = (await catalogResponse.json()) as {
      data: { skills: Array<{ id: string; name: string }> }
    }
    const skill = catalog.data.skills.find((item) => item.name === "slash-review")!
    const canonical = await request(`/api/session/${sessionID}/prompt`, tmp.path, {
      method: "POST",
      body: JSON.stringify({
        id: "msg_slash_canonical",
        prompt: {
          text: "$slash-review inspect $ARGUMENTS and $1",
          skills: [
            {
              id: skill.id,
              name: skill.name,
              source: { start: 0, end: 13, text: "$slash-review" },
            },
          ],
        },
        resume: false,
      }),
    })
    expect(canonical.status, await canonical.clone().text()).toBe(200)
    const canonicalPrompt = (await canonical.json()) as {
      data: {
        prompt: { invocations: Array<{ snapshot: { id: string; name: string; digest: string; content: string } }> }
      }
    }

    await fs.unlink(skillFile)
    await disposeAllInstances()
    const retried = await invoke("msg_slash_compatibility")
    expect(retried.status, await retried.clone().text()).toBe(200)
    expect(await retried.json()).toEqual(response)

    const missing = await invoke("msg_slash_missing")
    expect(missing.status).toBe(400)
    const history = await request(`/api/session/${sessionID}/history?limit=100`, tmp.path)
    const events = (await history.json()) as {
      data: Array<{
        type: string
        data: {
          prompt?: {
            text: string
            invocations?: Array<{ snapshot: { name: string; digest: string; content: string } }>
          }
        }
      }>
    }
    const admitted = events.data.filter((event) => event.type === "session.next.prompt.admitted")
    expect(admitted).toHaveLength(2)
    expect(admitted[0]?.data.prompt).toMatchObject({
      text: "$slash-review inspect $ARGUMENTS and $1",
      invocations: [{ snapshot: { content: expect.stringContaining("Keep $ARGUMENTS and $1 literal.") } }],
    })
    expect(admitted[0]?.data.prompt?.invocations?.[0]?.snapshot).toMatchObject({
      name: canonicalPrompt.data.prompt.invocations[0]!.snapshot.name,
      digest: canonicalPrompt.data.prompt.invocations[0]!.snapshot.digest,
      content: canonicalPrompt.data.prompt.invocations[0]!.snapshot.content,
    })
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
