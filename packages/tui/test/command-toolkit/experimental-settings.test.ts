import { describe, expect, test } from "bun:test"
import {
  experimentalCommandSettings,
  persistLocationEnvironment,
} from "../../src/command-toolkit/experimental-settings"

describe("experimental settings", () => {
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
        id: "fork.target.manage",
        key: "experimental.commands.target_manager",
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

  test("persists Location Environment through the canonical config patch", async () => {
    const patches: unknown[] = []
    const enabled = await persistLocationEnvironment(true, async (config) => {
      patches.push(config)
    })
    expect(enabled).toBeTrue()
    expect(patches).toEqual([{ experimental: { location_env: true } }])
  })

  test("does not report a changed value when persistence fails", async () => {
    expect(
      persistLocationEnvironment(false, async () => {
        throw new Error("write failed")
      }),
    ).rejects.toThrow("write failed")
  })
})
