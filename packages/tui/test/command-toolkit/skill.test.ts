import { describe, expect, test } from "bun:test"
import { createCommandHost } from "../../src/command-toolkit/host"
import { skillCommand, type SkillCommandContext } from "../../src/command-toolkit/skill"

describe("skill command", () => {
  test("opens the same local manager from slash and palette invocations", async () => {
    const opened: string[] = []
    const host = createCommandHost<SkillCommandContext>({
      register: (registry) => registry.register(skillCommand),
      context: (source) => ({
        source,
        client: "tui",
        abortSignal: new AbortController().signal,
        confirm: async () => false,
        openSkillManager: () => opened.push(source),
      }),
      upstream: () => undefined,
      invalid: () => undefined,
      outcome: () => undefined,
    })

    expect(host.registrations()).toEqual([
      expect.objectContaining({ name: "fork.skill.manage", slashName: "skills", title: "Manage skills" }),
    ])
    expect(await host("/skills")).toMatchObject({ status: "handled", identity: "fork.skill.manage" })
    await host.registrations()[0]!.run()
    expect(opened).toEqual(["slash", "palette"])
  })

  test("rejects arguments before opening the manager", () => {
    expect(
      skillCommand.parse({
        source: "/skills unexpected",
        value: "unexpected",
        range: { start: 8, end: 18 },
      }),
    ).toMatchObject({ status: "invalid", code: "unexpected_arguments" })
  })
})
