import { describe, expect, test } from "bun:test"
import { experimentalCommandSettings } from "../../src/command-toolkit/experimental-settings"

describe("experimental command settings", () => {
  test("uses one discoverable default-off setting per override", () => {
    expect(experimentalCommandSettings).toEqual([
      expect.objectContaining({
        id: "fork.session.rename-direct",
        key: "experimental.commands.rename_direct",
        defaultValue: false,
      }),
    ])
    expect(new Set(experimentalCommandSettings.map((setting) => setting.id)).size).toBe(
      experimentalCommandSettings.length,
    )
    expect(new Set(experimentalCommandSettings.map((setting) => setting.key)).size).toBe(
      experimentalCommandSettings.length,
    )
  })
})
