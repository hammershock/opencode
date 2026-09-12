import { describe, expect, test } from "bun:test"
import {
  buildDeviceRows,
  buildSyncOverviewRows,
  syncCloudStatus,
  syncStatus,
  type SyncSettingsViewModel,
} from "../../src/component/dialog-sync-settings"

const connected = {
  account: { state: "connected", maskedAccount: "ha***@example.com" },
  enabled: true,
  interval: 30,
  state: "idle",
  cloud: "unknown",
  devices: [],
  bindings: [],
  pending: 0,
} satisfies SyncSettingsViewModel

describe("Sync Settings presentation", () => {
  test("presents one account-wide synchronization workflow", () => {
    expect(buildSyncOverviewRows(connected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "ha***@example.com", status: "● connected" }),
        expect.objectContaining({ title: "Automatic sync", status: "● on" }),
        expect.objectContaining({ title: "Sync now", status: "● idle" }),
        expect.objectContaining({ title: "Interval", status: "30 sec" }),
        expect.objectContaining({ title: "Check cloud status", status: "○ not checked" }),
        expect.objectContaining({ title: "Clear cloud sync data" }),
      ]),
    )
    const text = JSON.stringify(buildSyncOverviewRows(connected)).toLowerCase()
    expect(text).not.toContain("space")
    expect(text).not.toContain("recovery")
    expect(text).not.toContain("encryption")
  })

  test("shows bounded remote cloud states without replacing local rows", () => {
    expect(buildSyncOverviewRows({ ...connected, cloud: "checking" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "◐ checking" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, cloud: "ready" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "● ready" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, cloud: "uninitialized" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "○ not initialized" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, cloud: "upgrade-required" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "! upgrade required" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, cloud: "replaced" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "! cloud data replaced" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, cloud: "unavailable" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Retry cloud status", status: "! unavailable" })]),
    )
  })

  test("shows OAuth progress and manual fallback without redisplaying application credentials", () => {
    expect(
      buildSyncOverviewRows({
        ...connected,
        account: { state: "disconnected", oauth: { state: "opening" } },
      }),
    ).toEqual([expect.objectContaining({ title: "Connect Baidu Netdisk", status: "◐ opening" })])
    const rows = buildSyncOverviewRows({
      ...connected,
      account: {
        state: "disconnected",
        oauth: { state: "waiting", authorizationURL: "https://openapi.baidu.com/oauth/authorize" },
      },
    })
    expect(rows.map((row) => row.title)).toEqual(["Connect Baidu Netdisk", "Copy authorization URL", "Use manual code"])
    expect(rows.join(" ")).not.toContain("AppKey")
    expect(rows.join(" ")).not.toContain("Secret")
    expect(
      buildSyncOverviewRows({
        ...connected,
        account: {
          state: "disconnected",
          oauth: { state: "manual", authorizationURL: "https://openapi.baidu.com/oauth/authorize" },
        },
      }),
    ).toEqual([
      expect.objectContaining({ title: "Connect Baidu Netdisk", status: "◐ waiting" }),
      expect.objectContaining({ title: "Copy authorization URL" }),
      expect.objectContaining({ title: "Enter authorization code" }),
    ])
  })

  test("uses the shared status vocabulary", () => {
    expect([
      syncStatus("off"),
      syncStatus("idle"),
      syncStatus("syncing"),
      syncStatus("locked"),
      syncStatus("attention"),
    ]).toEqual(["● off", "● idle", "◐ syncing", "! locked", "! attention"])
    expect(syncCloudStatus("incompatible")).toBe("! incompatible")
  })

  test("keeps the current device visible but non-revocable", () => {
    expect(buildDeviceRows([{ id: "mac", name: "Mac", current: true, state: "ready" }])).toEqual([
      expect.objectContaining({ title: "Mac", description: "This device", status: "● ready", disabled: false }),
    ])
  })
})
