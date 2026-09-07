import { describe, expect, test } from "bun:test"
import {
  buildSpaceRows,
  buildDeviceRows,
  buildSyncOverviewRows,
  maskRecoveryKey,
  syncStatus,
  type SyncSettingsViewModel,
} from "../../src/component/dialog-sync-settings"

const connected = {
  account: { state: "connected", maskedAccount: "ha***@example.com" },
  enabled: true,
  interval: 30,
  state: "idle",
  remote: "idle",
  activeSpace: {
    id: "space-1",
    name: "Research",
    supported: true,
    protocol: "1",
    encryption: "off",
    devices: 2,
    sessions: 12,
    membership: "active",
    state: "idle",
  },
  spaces: [],
  devices: [],
  bindings: [],
  pending: 0,
  unassigned: [],
} satisfies SyncSettingsViewModel

describe("Sync Settings presentation", () => {
  test("keeps overview labels short and statuses separate", () => {
    expect(buildSyncOverviewRows(connected)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "ha***@example.com", status: "● connected" }),
        expect.objectContaining({ title: "Check cloud status", status: "○ not checked" }),
        expect.objectContaining({ title: "Research", status: "● idle" }),
        expect.objectContaining({ title: "Auto sync", status: "● on" }),
        expect.objectContaining({ title: "Interval", status: "30 sec" }),
      ]),
    )
  })

  test("shows bounded remote refresh states without replacing local rows", () => {
    expect(buildSyncOverviewRows({ ...connected, remote: "checking" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "◐ checking" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, remote: "ready" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Cloud status", status: "● ready" })]),
    )
    expect(buildSyncOverviewRows({ ...connected, remote: "unavailable" })).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "Retry cloud status", status: "! unavailable" })]),
    )
  })

  test("makes an unconfigured manual sync actionable instead of looking runnable", () => {
    expect(buildSyncOverviewRows({ ...connected, activeSpace: undefined })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Sync now",
          description: "Select a space first",
          status: "! unavailable",
        }),
      ]),
    )
  })

  test("shows OAuth progress and manual fallback without client credentials", () => {
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
  })

  test("keeps unsupported spaces visible as summary-only rows", () => {
    const rows = buildSpaceRows([
      {
        ...connected.activeSpace,
        id: "future",
        protocol: "9",
        supported: false,
        membership: "available",
        state: "attention",
      },
    ])
    expect(rows[0]).toMatchObject({ title: "Research", status: "! unsupported", disabled: true })
    expect(rows[0]?.details).toContain("Protocol 9 · Encryption Off")
  })

  test("uses the shared status vocabulary and masks recovery keys", () => {
    expect([
      syncStatus("off"),
      syncStatus("idle"),
      syncStatus("syncing"),
      syncStatus("locked"),
      syncStatus("attention"),
    ]).toEqual(["● off", "● idle", "◐ syncing", "! locked", "! attention"])
    expect(maskRecoveryKey("oc-sync-secret-1234")).toBe("•••• 1234")
  })

  test("keeps the current device visible but non-revocable", () => {
    expect(buildDeviceRows([{ id: "mac", name: "Mac", current: true, state: "ready" }])).toEqual([
      expect.objectContaining({ title: "Mac", description: "This device", status: "● ready", disabled: false }),
    ])
  })
})
