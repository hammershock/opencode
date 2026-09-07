import { describe, expect, test } from "bun:test"
import {
  CommandRegistry,
  defineCommand,
  evaluateCommandRestrictions,
  type CompletionItem,
  type InvocationContext,
} from "../src"

describe("command contracts", () => {
  test("completion returns an explicit source replacement range", async () => {
    const definition = defineCommand({
      id: "core.environment.reload",
      path: ["env", "reload"],
      title: "Reload environment",
      provenance: { type: "core", feature: "environment" },
      capabilities: ["environment.reload"],
      parse: (raw) => ({ status: "parsed", input: raw.value }),
      complete: async (input): Promise<readonly CompletionItem[]> => [
        { label: "--force", replacement: { start: input.cursor, end: input.cursor } },
      ],
      execute: async () => ({ status: "completed" }),
    })
    const source = "/env reload --f"
    const items = await definition.complete?.(
      {
        source,
        cursor: source.length,
        arguments: { source, value: "--f", range: { start: 12, end: source.length } },
      },
      context(),
    )

    expect(items).toEqual([{ label: "--force", replacement: { start: source.length, end: source.length } }])
  })

  test.each([
    { status: "cancelled" as const, message: "Declined" },
    { status: "failed" as const, code: "environment.reload_failed", message: "Reload failed", retryable: true },
  ])("preserves the $status outcome without automatic retry", async (outcome) => {
    let attempts = 0
    const definition = defineCommand({
      id: "core.environment.reload",
      path: ["env", "reload"],
      title: "Reload environment",
      provenance: { type: "core", feature: "environment" },
      capabilities: ["environment.reload"],
      parse: () => ({ status: "parsed", input: undefined }),
      execute: async () => {
        attempts++
        return outcome
      },
    })

    expect(await definition.execute(context(), undefined)).toEqual(outcome)
    expect(attempts).toBe(1)
  })

  test("a registered command keeps typed parse input coupled to execution", async () => {
    const registry = new CommandRegistry()
    registry.register(
      defineCommand({
        id: "core.session.rename",
        path: ["rename"],
        title: "Rename session",
        provenance: { type: "core", feature: "session" },
        capabilities: ["session.write"],
        parse: (raw) =>
          raw.value
            ? { status: "parsed", input: { title: raw.value } }
            : { status: "invalid", code: "title.required", message: "Title is required" },
        execute: async (_context, input) => ({ status: "completed", message: input.title }),
      }),
    )
    const registered = registry.list()[0]
    expect(registered).toBeDefined()
    if (!registered) return

    const invalid = registered.prepare({ source: "/rename", value: "", range: { start: 7, end: 7 } })
    expect(invalid).toEqual({ status: "invalid", code: "title.required", message: "Title is required" })

    const prepared = registered.prepare({ source: "/rename New name", value: "New name", range: { start: 8, end: 16 } })
    expect(prepared.status).toBe("parsed")
    if (prepared.status !== "parsed") return
    expect(await prepared.execute(context())).toEqual({ status: "completed", message: "New name" })
  })

  test("device policy can only tighten a command's declared capability ceiling", () => {
    const command = {
      id: "core.environment.reload",
      capabilities: ["environment.reload", "workspace.read"],
    }
    expect(evaluateCommandRestrictions(command, undefined)).toEqual({ status: "allowed", confirm: false })
    expect(evaluateCommandRestrictions(command, { confirm: [command.id] })).toEqual({
      status: "allowed",
      confirm: true,
    })
    expect(evaluateCommandRestrictions(command, { disabled: [command.id] })).toEqual({
      status: "denied",
      code: "command_disabled",
    })
    expect(evaluateCommandRestrictions(command, { deniedCapabilities: ["environment.reload"] })).toEqual({
      status: "denied",
      code: "capability_denied",
      capability: "environment.reload",
    })
  })
})

function context(): InvocationContext {
  return {
    source: "slash",
    client: "tui",
    abortSignal: new AbortController().signal,
    confirm: async () => true,
  }
}
