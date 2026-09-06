import { describe, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode-ai/schema/schema"
import { ProjectID } from "@opencode-ai/schema/project-id"
import { Effect, Layer, Schema } from "effect"
import { Config } from "../src/config"
import { Global } from "../src/global"
import { Location } from "../src/location"
import { LocationEnvironment } from "../src/location-environment"
import { LocationEnvironmentWorkflow } from "../src/location-environment-workflow"

describe("LocationEnvironment.parse", () => {
  test("parses strict dotenv values without interpolation", () => {
    const result = LocationEnvironment.parse(
      "/remote/project/.env",
      [
        "# comment",
        "EMPTY=",
        "PLAIN=value # trailing",
        "SINGLE='hello world'",
        'DOUBLE="line\\nquote\\\"tab\\t"',
        "LITERAL=$BASE/${HOME}",
        "CRLF=ok\r",
      ].join("\r\n"),
    )
    expect(result.diagnostics).toEqual([])
    expect(result.values).toEqual({
      EMPTY: "",
      PLAIN: "value",
      SINGLE: "hello world",
      DOUBLE: 'line\nquote"tab\t',
      LITERAL: "$BASE/${HOME}",
      CRLF: "ok",
    })
  })

  test("rejects shell syntax and reports only source coordinates", () => {
    const result = LocationEnvironment.parse(
      "/remote/project/.env",
      ["export TOKEN=secret-value", "source ~/.profile", "FN() { echo bad; }", "A=$(steal)", "B=`steal`"].join("\n"),
    )
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "missing-equals",
      "missing-equals",
      "missing-equals",
      "command-substitution",
      "backtick",
    ])
    expect(JSON.stringify(result.diagnostics)).not.toContain("secret-value")
    expect(JSON.stringify(result.diagnostics)).not.toContain("steal")
  })

  test("supports multiline quoted values and rejects trailing code", () => {
    expect(LocationEnvironment.parse(".env", 'MULTI="one\ntwo"\n').values.MULTI).toBe("one\ntwo")
    expect(LocationEnvironment.parse(".env", 'BAD="value" && run\n').diagnostics[0]).toMatchObject({
      code: "trailing-content",
      line: 1,
    })
  })
})

describe("LocationEnvironment service", () => {
  test("merges target base, user, and ordered project layers without controller environment", async () => {
    const source = sourceFixture({
      base: { TARGET_ONLY: "remote", ORDER: "base" },
      files: [
        { path: "/remote/home/.config/opencode/.env", origin: "user", content: "ORDER=user\nUSER_ONLY=yes" },
        { path: "/workspace/.env", origin: "project", content: "ORDER=root\nROOT_ONLY=yes" },
        { path: "/workspace/sub/.env", origin: "project", content: "ORDER=cwd\nLITERAL=$TARGET_ONLY" },
      ],
    })
    const service = await run(source)
    const snapshot = await Effect.runPromise(service.snapshot())
    expect(snapshot.values).toEqual({
      TARGET_ONLY: "remote",
      ORDER: "cwd",
      USER_ONLY: "yes",
      ROOT_ONLY: "yes",
      LITERAL: "$TARGET_ONLY",
    })
    expect(snapshot.values.CONTROLLER_SECRET).toBeUndefined()
    expect(snapshot.variables.find((item) => item.name === "ORDER")).toMatchObject({
      origin: "project",
      source: "/workspace/sub/.env",
      overrides: ["base", "user", "project"],
    })
    expect(await Effect.runPromise(service.environment({ ORDER: "explicit" }))).toMatchObject({ ORDER: "explicit" })
    expect((await Effect.runPromise(service.snapshot())).values.ORDER).toBe("cwd")
  })

  test("keeps the old generation when reload parsing fails", async () => {
    const state = { content: "TOKEN=first" }
    const service = await run(
      sourceFixture(() => ({
        base: {},
        files: [{ path: "/workspace/.env", origin: "project", content: state.content }],
      })),
    )
    expect((await Effect.runPromise(service.snapshot())).generation).toBe(1)
    state.content = "TOKEN=$(bad)"
    const failed = await Effect.runPromiseExit(service.reload())
    expect(failed._tag).toBe("Failure")
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({ generation: 1, values: { TOKEN: "first" } })
    state.content = "TOKEN=second"
    expect(await Effect.runPromise(service.reload())).toMatchObject({ generation: 2, values: { TOKEN: "second" } })
  })

  test("serializes concurrent reload generations and notifies stale consumers", async () => {
    const service = await run(sourceFixture({ base: {}, files: [] }))
    const generations: number[] = []
    await Effect.runPromise(service.subscribe((generation) => generations.push(generation)))
    const snapshots = await Promise.all([Effect.runPromise(service.reload()), Effect.runPromise(service.reload())])
    expect(snapshots.map((item) => item.generation).sort()).toEqual([2, 3])
    expect(generations).toEqual([2, 3])
  })

  test("lists names without values and clears a reveal dialog on close", async () => {
    const service = await run(sourceFixture({ base: { SECRET_TOKEN: "sensitive-value" }, files: [] }))
    expect(JSON.stringify(await Effect.runPromise(service.list()))).not.toContain("sensitive-value")
    expect((await Effect.runPromise(service.reveal(false))).values()).toEqual({})
    const dialog = await Effect.runPromise(service.reveal(true))
    expect(dialog.values()).toEqual({ SECRET_TOKEN: "sensitive-value" })
    dialog.close()
    expect(dialog.values()).toEqual({})
  })

  test("disabled mode publishes only target base and ignores dotenv", async () => {
    const service = await run(
      sourceFixture({
        base: { BASE: "target" },
        files: [{ path: "/workspace/.env", origin: "project", content: "BASE=project" }],
      }),
      false,
    )
    expect(await Effect.runPromise(service.snapshot())).toMatchObject({ enabled: false, values: { BASE: "target" } })
  })
})

describe("LocationEnvironmentWorkflow.init", () => {
  test("does not reload after Agent cancellation or failure", async () => {
    const calls: string[] = []
    const environment = workflowFixture(calls)
    expect(
      await Effect.runPromise(LocationEnvironmentWorkflow.init(environment, () => Effect.succeed("cancelled"))),
    ).toEqual({ status: "cancelled", template: "created" })
    expect(calls).toEqual(["template"])
    calls.length = 0
    expect(
      await Effect.runPromise(LocationEnvironmentWorkflow.init(environment, () => Effect.succeed("failed"))),
    ).toEqual({
      status: "failed",
      template: "created",
    })
    expect(calls).toEqual(["template"])
  })

  test("reloads only after Agent completion and propagates parse failure", async () => {
    const calls: string[] = []
    const environment = workflowFixture(calls, "existing")
    expect(
      await Effect.runPromise(LocationEnvironmentWorkflow.init(environment, () => Effect.succeed("completed"))),
    ).toEqual({ status: "completed", template: "existing", generation: 2 })
    expect(calls).toEqual(["template", "reload"])
  })
})

function sourceFixture(capture: LocationEnvironment.Capture | (() => LocationEnvironment.Capture)) {
  return LocationEnvironment.Source.of({
    capture: () => Effect.succeed(typeof capture === "function" ? capture() : capture),
    ensureTemplate: () => Effect.succeed("created"),
  })
}

async function run(source: LocationEnvironment.SourceInterface, enabled = true) {
  const global = Global.make({ config: "/control/config", home: "/control/home" })
  const location = Location.Service.of({
    target: { type: "rexd", targetID: Location.TargetID.make("01947d1c-b988-74d4-bec1-dfaf715d194a") },
    directory: AbsolutePath.make("/workspace/sub"),
    project: { id: ProjectID.make("global"), directory: AbsolutePath.make("/workspace") },
  })
  const config = Config.Service.of({
    entries: () =>
      Effect.succeed([
        new Config.Document({
          type: "document",
          path: "/control/config/opencode.jsonc",
          info: Schema.decodeUnknownSync(Config.Info)({ experimental: { location_env: enabled } }),
        }),
      ]),
  })
  return Effect.runPromise(
    LocationEnvironment.Service.pipe(
      Effect.provide(LocationEnvironment.layer),
      Effect.provide(Layer.succeed(LocationEnvironment.Source)(source)),
      Effect.provide(Layer.succeed(Location.Service)(location)),
      Effect.provide(Layer.succeed(Config.Service)(config)),
      Effect.provide(Layer.succeed(Global.Service)(global)),
      Effect.scoped,
    ),
  )
}

function workflowFixture(calls: string[], template: "created" | "existing" = "created"): LocationEnvironment.Interface {
  return {
    snapshot: () => Effect.die("unused"),
    environment: () => Effect.die("unused"),
    list: () => Effect.die("unused"),
    reveal: () => Effect.die("unused"),
    subscribe: () => Effect.die("unused"),
    ensureTemplate: () => Effect.sync(() => (calls.push("template"), template)),
    reload: () =>
      Effect.sync(() => {
        calls.push("reload")
        return {
          enabled: true,
          generation: 2,
          values: {},
          variables: [],
          sources: [],
        }
      }),
  }
}
