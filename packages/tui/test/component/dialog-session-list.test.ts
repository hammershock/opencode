import { describe, expect, test } from "bun:test"
import {
  SESSION_FILTER_FOOTER_HINT,
  createDialogSessionListQuery,
  dialogSessionListLocationFilter,
  dialogSessionListSyncStatus,
  dialogSessionListTargetLabel,
  dialogSessionListTargetOptions,
  loadDialogSessionList,
  sessionInDialogTarget,
  syncAvailabilityLabel,
  updateDialogSessionListFilters,
} from "../../src/component/dialog-session-list"

describe("dialog session list", () => {
  test("advertises Tab as the filter-row navigation key", () => {
    expect(SESSION_FILTER_FOOTER_HINT).toEqual({ title: "tab", label: "filters" })
  })

  test("requests root sessions for the default browse list", () => {
    expect(createDialogSessionListQuery({ filter: { path: "packages/tui" } })).toEqual({
      roots: true,
      limit: 100,
      path: "packages/tui",
    })
  })

  test("requests root sessions for search results", () => {
    expect(createDialogSessionListQuery({ search: " deploy ", filter: { scope: "project" } })).toEqual({
      roots: true,
      limit: 30,
      search: "deploy",
      scope: "project",
    })
  })

  test("keeps the cache usable while the root request is pending", async () => {
    let resolve!: (result: { data: string[] }) => void
    const pending = loadDialogSessionList<string>({
      filter: {},
      list: () => new Promise((done) => (resolve = done)),
    })

    expect(await Promise.race([pending, Promise.resolve("pending")])).toBe("pending")
    resolve({ data: ["root"] })
    expect(await pending).toEqual(["root"])
  })

  test("falls back when the root request returns an error response", async () => {
    expect(await loadDialogSessionList({ filter: {}, list: async () => ({}) })).toBeUndefined()
  })

  test("falls back when the root request rejects", async () => {
    expect(
      await loadDialogSessionList({
        filter: {},
        list: () => Promise.reject(new Error("offline")),
      }),
    ).toBeUndefined()
  })

  test("labels every metadata-first availability state", () => {
    expect(syncAvailabilityLabel("metadata-only")).toBe("◐ metadata-only")
    expect(syncAvailabilityLabel("hydrating")).toBe("◐ hydrating")
    expect(syncAvailabilityLabel("ready")).toBe("● ready")
    expect(syncAvailabilityLabel("partial")).toBe("! partial")
    expect(syncAvailabilityLabel("conflict")).toBe("! conflict")
    expect(syncAvailabilityLabel("unresolved")).toBe("! unresolved")
  })

  test("tabs between Path and Target while enforcing their valid combinations", () => {
    const targets = ["local", "all", "a100-2gpu"]
    const initial = { focus: "cwd" as const, cwd: "cwd" as const, target: "local" }
    expect(updateDialogSessionListFilters(initial, "right", targets)).toEqual({ ...initial, cwd: "all" })

    const target = updateDialogSessionListFilters(initial, "tab", targets)
    expect(target).toEqual({ ...initial, focus: "target" })
    expect(updateDialogSessionListFilters(target, "right", targets)).toEqual({
      focus: "target",
      cwd: "all",
      target: "all",
    })
    expect(updateDialogSessionListFilters({ ...target, cwd: "all", target: "all" }, "right", targets)).toEqual({
      focus: "target",
      cwd: "all",
      target: "a100-2gpu",
    })
    expect(updateDialogSessionListFilters({ focus: "cwd", cwd: "all", target: "a100-2gpu" }, "left", targets)).toEqual({
      focus: "cwd",
      cwd: "cwd",
      target: "local",
    })
  })

  test("maps Cwd to the upstream path query and All to the upstream project query", () => {
    expect(
      dialogSessionListLocationFilter({ mode: "cwd", worktree: "/repo", directory: "/repo/packages/tui" }),
    ).toEqual({ path: "packages/tui" })
    expect(
      dialogSessionListLocationFilter({ mode: "all", worktree: "/repo", directory: "/repo/packages/tui" }),
    ).toEqual({ scope: "project" })
    expect(dialogSessionListLocationFilter({ mode: "cwd" })).toEqual({ scope: "project" })
  })

  test("builds stable target choices from local, remote, cloud, and delayed persisted state", () => {
    const sessions = [
      { directory: "/local" },
      { directory: "/gpu", targetLabel: "a100-2gpu" },
      { directory: "/gpu-duplicate", targetLabel: "a100-2gpu" },
      { directory: "/windows", targetLabel: "mywindows" },
    ]
    expect(dialogSessionListTargetOptions(sessions)).toEqual(["local", "all", "a100-2gpu", "mywindows"])
    expect(dialogSessionListTargetOptions(sessions, "mymac")).toEqual([
      "local",
      "all",
      "a100-2gpu",
      "mywindows",
      "mymac",
    ])
  })

  test("filters by target name without conflating local with a foreign device", () => {
    const local = { directory: "/repo" }
    const foreignLocal = { directory: "/repo", targetLabel: "mymac" }
    expect(sessionInDialogTarget(local, "local")).toBe(true)
    expect(sessionInDialogTarget(foreignLocal, "local")).toBe(false)
    expect(sessionInDialogTarget(foreignLocal, "mymac")).toBe(true)
    expect(sessionInDialogTarget(local, "all")).toBe(true)
    expect(sessionInDialogTarget(foreignLocal, "all")).toBe(true)
  })

  test("keeps this device local and exposes a foreign device through its target name", () => {
    expect(
      dialogSessionListTargetLabel({
        remote: { ownerDeviceID: "mac", targetLabel: "mymac" },
        currentDeviceID: "mac",
      }),
    ).toBeUndefined()
    expect(
      dialogSessionListTargetLabel({
        remote: { ownerDeviceID: "mac", targetLabel: "mymac" },
        currentDeviceID: "windows",
      }),
    ).toBe("mymac")
  })

  test("marks cloud-only rows without changing hydrated availability labels", () => {
    const metadata = {
      sessionID: "session",
      title: "Cloud",
      ownerDeviceID: "device",
      sourceDeviceID: "device",
      directory: "/repo",
      updatedAt: 1,
      availability: "unresolved" as const,
    }
    expect(dialogSessionListSyncStatus({ cloudOnly: true, syncMetadata: metadata })).toBe("cloud")
    expect(dialogSessionListSyncStatus({ syncMetadata: metadata })).toBe("! unresolved")
    expect(dialogSessionListSyncStatus({})).toBeUndefined()
  })
})
