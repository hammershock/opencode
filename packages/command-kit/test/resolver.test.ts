import { describe, expect, test } from "bun:test"
import { CommandRegistry, createHostResolver, defineCommand, resolveCore, type InvocationContext } from "../src"

describe("resolveCore", () => {
  test("uses the longest matching leaf", () => {
    const registry = fixtureRegistry()
    const result = resolveCore("/env init template", registry.routes())

    expect(result.status).toBe("matched")
    if (result.status !== "matched") return
    expect(result.command.id).toBe("core.environment.init")
    expect(result.arguments.value).toBe("template")
    expect(result.arguments.range).toEqual({ start: 10, end: 18 })
  })

  test("resolves aliases and reports the route used", () => {
    const result = resolveCore("/environment reload", fixtureRegistry().routes())

    expect(result.status).toBe("matched")
    if (result.status !== "matched") return
    expect(result.command.id).toBe("core.environment.root")
    expect(result.route).toEqual(["environment"])
    expect(result.routeType).toBe("alias")
    expect(result.arguments.value).toBe("reload")
  })

  test("preserves raw spacing, unicode, and multiline arguments", () => {
    const source = "/rename \t  标题 with  spaces\nsecond\nthird"
    const result = resolveCore(source, fixtureRegistry().routes())

    expect(result.status).toBe("matched")
    if (result.status !== "matched") return
    expect(result.arguments.value).toBe("标题 with  spaces\nsecond\nthird")
    expect(result.arguments.source).toBe(source)
    expect(source.slice(result.arguments.range.start, result.arguments.range.end)).toBe(result.arguments.value)
  })

  test("does not treat later lines as command path tokens", () => {
    const result = resolveCore("/env\ninit", fixtureRegistry().routes())

    expect(result.status).toBe("matched")
    if (result.status !== "matched") return
    expect(result.command.id).toBe("core.environment.root")
    expect(result.arguments.value).toBe("init")
  })

  test.each([
    ["leading whitespace", " /env"],
    ["plain prompt", "env"],
  ])("does not consume %s", (_name, input) => {
    expect(resolveCore(input, fixtureRegistry().routes())).toEqual({ status: "not-slash" })
  })

  test("returns not-found for an unknown slash command", () => {
    expect(resolveCore("/unknown value", fixtureRegistry().routes())).toEqual({ status: "not-found" })
  })
})

describe("upstream-first host fixture", () => {
  test("keeps the upstream winner and diagnoses the shadowed core command", () => {
    const resolver = createHostResolver(fixtureRegistry().routes(), (input) =>
      input.startsWith("/env")
        ? { id: "upstream.custom.env", path: ["env"], provenance: { type: "project-config" } }
        : undefined,
    )
    const result = resolver("/env init")

    expect(result.status).toBe("upstream")
    if (result.status !== "upstream") return
    expect(result.candidate.id).toBe("upstream.custom.env")
    expect(result.diagnostics).toEqual([
      {
        type: "shadowed",
        winner: { id: "upstream.custom.env", path: ["env"], provenance: { type: "project-config" } },
        shadowed: {
          id: "core.environment.init",
          path: ["env", "init"],
          provenance: { type: "core", feature: "environment" },
        },
      },
    ])
  })

  test("preserves upstream resolver order and every shadowing diagnostic", () => {
    const winner = { id: "project.env", path: ["env"], provenance: { type: "project-config" as const } }
    const plugin = {
      id: "plugin.env",
      path: ["env"],
      provenance: { type: "legacy-plugin" as const, pluginID: "fixture" },
    }
    const result = createHostResolver(fixtureRegistry().routes(), () => [winner, plugin])("/env init")
    expect(result.status).toBe("upstream")
    if (result.status !== "upstream") return
    expect(result.candidate).toEqual(winner)
    expect(result.diagnostics).toEqual([
      { type: "shadowed", winner, shadowed: plugin },
      {
        type: "shadowed",
        winner,
        shadowed: {
          id: "core.environment.init",
          path: ["env", "init"],
          provenance: { type: "core", feature: "environment" },
        },
      },
    ])
  })

  test("uses core only after upstream declines", () => {
    const result = createHostResolver(fixtureRegistry().routes(), () => undefined)("/env init")
    expect(result.status).toBe("core")
  })

  test.each(["/unknown value", "ordinary prompt", " /env init"])(
    "passes unmatched input through unchanged: %s",
    (input) => {
      expect(createHostResolver(fixtureRegistry().routes(), () => undefined)(input)).toEqual({
        status: "passthrough",
        input,
        diagnostics: [],
      })
    },
  )
})

function fixtureRegistry() {
  const registry = new CommandRegistry()
  registry.register(command("core.environment.root", ["env"], [["environment"]]))
  registry.register(command("core.environment.init", ["env", "init"]))
  registry.register(command("core.session.rename", ["rename"]))
  return registry
}

function command(id: string, path: readonly string[], aliases?: readonly (readonly string[])[]) {
  return defineCommand({
    id,
    path,
    aliases,
    title: id,
    provenance: { type: "core", feature: id.includes("environment") ? "environment" : "session" },
    capabilities: [],
    parse: (raw) => ({ status: "parsed", input: raw.value }),
    execute: async (_context: InvocationContext, value) => ({ status: "completed", message: value }),
  })
}
