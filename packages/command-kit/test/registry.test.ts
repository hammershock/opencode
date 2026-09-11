import { describe, expect, test } from "bun:test"
import {
  CommandRegistry,
  CommandRegistryError,
  defineCommand,
  type CommandDefinition,
  type InvocationContext,
} from "../src"

describe("CommandRegistry", () => {
  test("registers canonical paths and aliases", () => {
    const registry = new CommandRegistry()
    registry.register(command({ id: "core.environment.reload", path: ["env", "reload"], aliases: [["env", "r"]] }))

    expect(registry.list().map((item) => item.id)).toEqual(["core.environment.reload"])
    expect(registry.routes().map((item) => [item.path, item.type])).toEqual([
      [["env", "reload"], "canonical"],
      [["env", "r"], "alias"],
    ])
  })

  test("rejects duplicate identities without mutating the registry", () => {
    const registry = new CommandRegistry()
    registry.register(command({ id: "core.environment.reload", path: ["env", "reload"] }))

    expect(() => registry.register(command({ id: "core.environment.reload", path: ["different"] }))).toThrow(
      CommandRegistryError,
    )
    expect(registry.list()).toHaveLength(1)
    expect(registry.routes()).toHaveLength(1)
  })

  test.each([
    ["canonical path", { id: "core.environment.status", path: ["env", "reload"] }],
    ["alias", { id: "core.environment.status", path: ["env", "status"], aliases: [["env", "reload"]] }],
  ])("rejects a conflicting %s atomically", (_name, input) => {
    const registry = new CommandRegistry()
    registry.register(command({ id: "core.environment.reload", path: ["env", "reload"] }))

    expect(() => registry.register(command(input))).toThrow(CommandRegistryError)
    expect(registry.list().map((item) => item.id)).toEqual(["core.environment.reload"])
    expect(registry.routes()).toHaveLength(1)
  })

  test("rejects an alias that duplicates its own canonical path", () => {
    const registry = new CommandRegistry()
    expect(() =>
      registry.register(
        command({ id: "core.environment.reload", path: ["env", "reload"], aliases: [["env", "reload"]] }),
      ),
    ).toThrow(CommandRegistryError)
    expect(registry.list()).toHaveLength(0)
  })

  test.each([
    ["single token id", { id: "reload", path: ["env"] }],
    ["uppercase path", { id: "core.environment.reload", path: ["Env"] }],
    ["slash in token", { id: "core.environment.reload", path: ["env/reload"] }],
    ["empty path", { id: "core.environment.reload", path: [] }],
  ])("rejects invalid definitions: %s", (_name, input) => {
    expect(() => new CommandRegistry().register(command(input))).toThrow(TypeError)
  })
})

function command(
  input: Pick<CommandDefinition<string>, "id" | "path"> & Partial<Pick<CommandDefinition<string>, "aliases">>,
) {
  return defineCommand({
    ...input,
    title: input.id,
    provenance: { type: "core", feature: "test" },
    readOnly: false,
    capabilities: [],
    parse: (raw) => ({ status: "parsed", input: raw.value }),
    execute: async (_context: InvocationContext, value) => ({ status: "completed", message: value }),
  })
}
