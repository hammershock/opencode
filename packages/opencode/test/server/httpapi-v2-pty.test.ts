import { afterEach, describe, expect, test } from "bun:test"
import { Context, Config as EffectConfig, Effect, Layer, Queue, Schema } from "effect"
import { NodeHttpServer, NodeServices } from "@effect/platform-node"
import { HttpClient, HttpClientRequest, HttpRouter, HttpServer } from "effect/unstable/http"
import * as Socket from "effect/unstable/socket/Socket"
import path from "path"
import { pathToFileURL } from "url"
import { mkdir } from "fs/promises"
import { createReadStream } from "fs"
import { Location } from "@opencode-ai/core/location"
import { Pty } from "@opencode-ai/core/pty"
import { PtyTicket } from "@opencode-ai/core/pty/ticket"
import { HttpApiApp } from "../../src/server/routes/instance/httpapi/server"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances, tmpdir, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const context = Context.empty() as Context.Context<unknown>
const testPty = process.platform === "win32" ? test.skip : test

function request(route: string, directory: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  headers.set("x-opencode-directory", directory)
  return HttpApiApp.webHandler().handler(
    new Request(`http://localhost${route}`, {
      ...init,
      headers,
    }),
    context,
  )
}

const testStateLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    yield* Effect.promise(() => resetDatabase())
    yield* Effect.addFinalizer(() => Effect.promise(() => resetDatabase()))
  }),
)

const servedRoutes: Layer.Layer<never, EffectConfig.ConfigError, HttpServer.HttpServer> = HttpRouter.serve(
  HttpApiApp.routes,
  { disableListenLog: true, disableLogger: true },
)

const effectIt = testEffect(
  Layer.mergeAll(
    testStateLayer,
    Socket.layerWebSocketConstructorGlobal,
    servedRoutes.pipe(
      Layer.provide(Socket.layerWebSocketConstructorGlobal),
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provideMerge(NodeServices.layer),
    ),
  ),
)

const directoryHeader = (dir: string) => HttpClientRequest.setHeader("x-opencode-directory", dir)

const serverUrl = () => HttpServer.HttpServer.use((server) => Effect.succeed(HttpServer.formatAddress(server.address)))

afterEach(async () => {
  await disposeAllInstances()
  await resetDatabase()
})

describe("v2 pty HttpApi", () => {
  testPty("rejects a stale Session Location admission token before creating or restarting a PTY", async () => {
    await using first = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    await using second = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const createdSession = await request("/api/session", first.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { target: { type: "local" }, directory: first.path } }),
    })
    expect(createdSession.status).toBe(200)
    const sessionID = ((await createdSession.json()) as { data: { id: string } }).data.id
    const createdPty = await request("/api/pty", first.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID, command: "/bin/sh" }),
    })
    expect(createdPty.status).toBe(200)
    const original = Schema.decodeUnknownSync(Location.response(Pty.Info))(await createdPty.json()).data

    const stale = await request("/api/pty", second.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID, command: "/usr/bin/env", args: ["sh", "-c", "exit 0"] }),
    })
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "session_location_changed",
    })
    expect(
      Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(
        await (await request("/api/pty", second.path)).json(),
      ).data,
    ).toEqual([])

    const staleRestart = await request(`/api/pty/${original.id}/restart`, second.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID }),
    })
    expect(staleRestart.status).toBe(400)
    expect(await staleRestart.json()).toMatchObject({
      _tag: "InvalidRequestError",
      kind: "session_location_changed",
    })
    expect((await request(`/api/pty/${original.id}`, first.path)).status).toBe(200)
    await request(`/api/pty/${original.id}`, first.path, { method: "DELETE" })
  })

  testPty("restarts one running PTY through the canonical route", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const createdSession = await request("/api/session", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: { target: { type: "local" }, directory: tmp.path } }),
    })
    expect(createdSession.status).toBe(200)
    const sessionID = ((await createdSession.json()) as { data: { id: string } }).data.id
    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID, command: "/bin/sh", title: "restart-me" }),
    })
    expect(created.status).toBe(200)
    const original = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data

    const restarted = await request(`/api/pty/${original.id}/restart`, tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionID }),
    })
    expect(restarted.status).toBe(200)
    const replacement = Schema.decodeUnknownSync(Location.response(Pty.Info))(await restarted.json()).data
    expect(replacement.id).not.toBe(original.id)
    expect(replacement.title).toBe("restart-me")
    expect(replacement.environmentStale).toBe(false)

    expect((await request(`/api/pty/${original.id}`, tmp.path)).status).toBe(404)
    expect(
      (
        await request(`/api/pty/pty_missing/restart`, tmp.path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionID }),
        })
      ).status,
    ).toBe(404)
    await request(`/api/pty/${replacement.id}`, tmp.path, { method: "DELETE" })
  })

  testPty("serves location-wrapped PTY routes and retains exited sessions", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const exitGate = path.join(tmp.path, "exit-gate")
    const fifo = Bun.spawn(["mkfifo", exitGate])
    expect(await fifo.exited).toBe(0)

    const empty = await request("/api/pty", tmp.path)
    expect(empty.status).toBe(200)
    expect(Schema.decodeUnknownSync(Location.response(Schema.Array(Pty.Info)))(await empty.json()).data).toEqual([])

    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "/bin/sh",
        args: ["-c", 'read _ < "$EXIT_GATE"; exit 4'],
        title: "v2",
        env: { EXIT_GATE: exitGate },
      }),
    })
    expect(created.status).toBe(200)
    const body = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json())
    expect(String(body.location.directory)).toBe(tmp.path)
    expect(body.data.title).toBe("v2")

    // PTY listeners are installed before the command is released, so a fast
    // process cannot exit before the retention observer is ready.
    const release = Bun.spawn(["/bin/sh", "-c", 'printf "go\\n" > "$1"', "sh", exitGate])
    expect(await release.exited).toBe(0)

    // The canonical surface keeps exited sessions observable with their exit code.
    const deadline = Date.now() + 20_000
    let info: { status: string; exitCode?: number } | undefined
    while (Date.now() < deadline) {
      const found = await request(`/api/pty/${body.data.id}`, tmp.path)
      expect(found.status).toBe(200)
      info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await found.json()).data
      if (info.status === "exited") break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    expect(info).toMatchObject({ status: "exited", exitCode: 4 })

    const removed = await request(`/api/pty/${body.data.id}`, tmp.path, { method: "DELETE" })
    expect(removed.status).toBe(204)

    const missing = await request(`/api/pty/${body.data.id}`, tmp.path)
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ _tag: "PtyNotFoundError", ptyID: body.data.id })
  })

  testPty("rejects connect tokens without the CSRF header and connects with a valid ticket", async () => {
    await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
    const created = await request("/api/pty", tmp.path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "/usr/bin/env", args: ["sh", "-c", "sleep 5"] }),
    })
    expect(created.status).toBe(200)
    const info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data

    try {
      const forbidden = await request(`/api/pty/${info.id}/connect-token`, tmp.path, { method: "POST" })
      expect(forbidden.status).toBe(403)
      expect(await forbidden.json()).toMatchObject({ _tag: "ForbiddenError" })

      const token = await request(`/api/pty/${info.id}/connect-token`, tmp.path, {
        method: "POST",
        headers: { "x-opencode-ticket": "1" },
      })
      expect(token.status).toBe(200)
      const ticket = Schema.decodeUnknownSync(Location.response(PtyTicket.ConnectToken))(await token.json()).data.ticket
      expect(ticket).toBeTruthy()

      const invalid = await request(`/api/pty/${info.id}/connect?ticket=not-a-ticket`, tmp.path)
      expect(invalid.status).toBe(403)
    } finally {
      await request(`/api/pty/${info.id}`, tmp.path, { method: "DELETE" })
    }
  })
  ;(process.platform === "win32" ? effectIt.live.skip : effectIt.live)(
    "serves PTY websocket output and input through the canonical route",
    () =>
      Effect.gen(function* () {
        const dir = yield* tmpdirScoped({ git: true, config: { formatter: false, lsp: false } })
        const created = yield* HttpClientRequest.post("/api/pty").pipe(
          directoryHeader(dir),
          HttpClientRequest.bodyJson({ command: "/bin/cat", title: "v2-websocket" }),
          Effect.flatMap(HttpClient.execute),
        )
        expect(created.status).toBe(200)
        const body = yield* Schema.decodeUnknownEffect(Location.response(Pty.Info))(yield* created.json)
        const info = body.data

        const socket = yield* Socket.makeWebSocket(
          `${(yield* serverUrl()).replace(/^http/, "ws")}/api/pty/${info.id}/connect?cursor=-1&location[directory]=${encodeURIComponent(dir)}`,
          { closeCodeIsError: () => false },
        )
        const messages = yield* Queue.unbounded<string>()
        yield* socket
          .runRaw((message) =>
            Queue.offer(messages, typeof message === "string" ? message : new TextDecoder().decode(message)),
          )
          .pipe(Effect.catch(() => Effect.void))
          .pipe(Effect.forkScoped)
        const write = yield* socket.writer

        const takeUntil = (expected: string, seen = ""): Effect.Effect<string, unknown> =>
          Effect.gen(function* () {
            const next = seen + (yield* Queue.take(messages).pipe(Effect.timeout("5 seconds")))
            if (next.includes(expected)) return next
            return yield* takeUntil(expected, next)
          })

        yield* write("ping-v2\n")
        expect(yield* takeUntil("ping-v2")).toContain("ping-v2")
        yield* write(new Socket.CloseEvent(1000, "done")).pipe(Effect.catch(() => Effect.void))

        const removed = yield* HttpClientRequest.delete(`/api/pty/${info.id}`).pipe(
          directoryHeader(dir),
          HttpClient.execute,
        )
        expect(removed.status).toBe(204)
      }),
  )
  testPty(
    "applies plugin shell environment before forced PTY values",
    async () => {
      await using tmp = await tmpdir({ git: true, config: { formatter: false, lsp: false } })
      const dir = tmp.path
      const plugin = path.join(dir, "plugin.ts")
      const cwd = path.join(dir, "child")
      const output = path.join(cwd, "environment.txt")
      await mkdir(cwd)
      await Bun.write(
        plugin,
        [
          "export default async () => ({",
          '  "shell.env": (input, output) => {',
          '    output.env.SHARED = "plugin"',
          '    output.env.PLUGIN = "plugin"',
          '    output.env.TERM = "plugin"',
          "    output.env.HOOK_CWD = input.cwd",
          "  },",
          "})",
          "",
        ].join("\n"),
      )
      await Bun.write(
        path.join(dir, "opencode.json"),
        JSON.stringify({ plugin: [pathToFileURL(plugin).href], formatter: false, lsp: false }),
      )

      const fifo = Bun.spawn(["mkfifo", output])
      expect(await fifo.exited).toBe(0)
      const reader = createReadStream(output, { encoding: "utf8" })
      const outputReady = new Promise<string>((resolve, reject) => {
        let value = ""
        reader.on("data", (chunk) => (value += chunk))
        reader.on("end", () => resolve(value))
        reader.on("error", reject)
      })

      let ptyID: string | undefined
      try {
        const created = await request("/api/pty", dir, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            command: "/bin/sh",
            args: ["-c", 'printf "%s|%s|%s|%s|%s\\n" "$CALLER" "$SHARED" "$PLUGIN" "$TERM" "$HOOK_CWD" > "$OUTPUT"'],
            cwd,
            env: { CALLER: "caller", SHARED: "caller", TERM: "caller", OUTPUT: output },
          }),
        })
        expect(created.status).toBe(200)
        const info = Schema.decodeUnknownSync(Location.response(Pty.Info))(await created.json()).data
        ptyID = info.id

        expect(await outputReady).toContain(`caller|plugin|plugin|xterm-256color|${cwd}`)
      } finally {
        reader.destroy()
        if (ptyID) await request(`/api/pty/${ptyID}`, dir, { method: "DELETE" })
      }
    },
    { timeout: 15_000 },
  )
})
