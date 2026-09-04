import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import {
  baiduAuthorizationUrl,
  configureCloudSync,
  createDeviceManifest,
  decodeSyncPack,
  encodeSyncPack,
  mergeSyncEvents,
  readCloudSyncConfig,
  type SyncPack,
} from "../../src/util/cloud-sync"

const homes: string[] = []

function pack(deviceID: string, generation: number, events: SyncPack["events"]): SyncPack {
  return { version: 1, deviceID, generation, createdAt: 1000 + generation, events }
}

afterEach(() => homes.splice(0).forEach((home) => rmSync(home, { recursive: true, force: true })))

describe("cloud sync", () => {
  test("keeps a stable device identity when configuration changes", () => {
    const home = mkdtempSync(path.join(tmpdir(), "opencode-cloud-sync-"))
    homes.push(home)
    const first = configureCloudSync(home, { deviceName: "MacBook" })
    const second = configureCloudSync(home, { deviceName: "Linux", enabled: true })
    expect(second.deviceID).toBe(first.deviceID)
    expect(second.enabled).toBe(true)
    expect(readCloudSyncConfig(home)?.deviceName).toBe("Linux")
  })

  test("builds a per-user Baidu OAuth authorization URL", () => {
    const url = new URL(baiduAuthorizationUrl("private-app-key"))
    expect(url.searchParams.get("client_id")).toBe("private-app-key")
    expect(url.searchParams.get("scope")).toBe("basic,netdisk")
    expect(url.searchParams.get("redirect_uri")).toBe("oob")
  })

  test("round-trips a compressed rolling pack and builds its manifest", () => {
    const value = pack("mac", 3, [
      { id: "evt-1", aggregateID: "session-1", seq: 0, type: "session.created@1", data: { title: "A" } },
      { id: "evt-2", aggregateID: "session-1", seq: 1, type: "message.created@1", data: { text: "B" } },
    ])
    expect(decodeSyncPack(encodeSyncPack(value))).toEqual(value)
    expect(createDeviceManifest(value)).toMatchObject({ generation: 3, eventCount: 2, heads: { "session-1": 1 } })
  })

  test("deduplicates identical events and reports divergent revisions", () => {
    const event = { id: "evt-1", aggregateID: "session-1", seq: 0, type: "session.created@1", data: {} }
    expect(mergeSyncEvents([pack("mac", 1, [event]), pack("linux", 1, [event])])).toEqual([event])
    expect(() => mergeSyncEvents([pack("mac", 1, [event]), pack("linux", 1, [{ ...event, id: "evt-2" }])])).toThrow(
      "Sync conflict",
    )
  })
})
