import { describe, expect, test } from "bun:test"
import { experimentalCommandSettings } from "../../src/command-toolkit/experimental-settings"

describe("experimental command settings", () => {
  test("uses one discoverable default-off setting per override", () => {
    expect(experimentalCommandSettings).toEqual([
      expect.objectContaining({
        id: "fork.session.exit-to-home",
        key: "experimental.commands.exit_to_home",
        defaultValue: false,
      }),
      expect.objectContaining({
        id: "fork.session.rename-direct",
        key: "experimental.commands.rename_direct",
        defaultValue: false,
      }),
      expect.objectContaining({
        id: "fork.session.force-rebind",
        key: "experimental.session.force_rebind",
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
