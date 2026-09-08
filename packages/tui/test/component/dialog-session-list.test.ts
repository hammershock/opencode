import { describe, expect, test } from "bun:test"
import {
  SESSION_FILTER_FOOTER_HINT,
  createDialogSessionListQuery,
  dialogSessionListScopeSelection,
  dialogSessionListLocationFilter,
  includeCloudSessionInDialogScope,
  loadDialogSessionList,
  sessionInDialogSyncScope,
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

  test("tabs between fixed filter rows and arrows change only the focused value", () => {
    const initial = { focus: "cwd" as const, cwd: "cwd" as const, scope: "current" as const }
    expect(updateDialogSessionListFilters(initial, "right")).toEqual({ ...initial, cwd: "all" })
    const scope = updateDialogSessionListFilters(initial, "tab")
    expect(scope).toEqual({ ...initial, focus: "scope" })
    expect(updateDialogSessionListFilters(scope, "left")).toEqual({ ...scope, scope: "all" })
    expect(updateDialogSessionListFilters(scope, "tab")).toEqual(initial)
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

  test("Synced filters the internal account scope while All keeps every local Session", () => {
    const active = { syncSpaceID: "active" }
    const inactive = { syncSpaceID: "inactive" }
    const unassigned = {}
    expect(sessionInDialogSyncScope(active, "current", "active")).toBe(true)
    expect(sessionInDialogSyncScope(inactive, "current", "active")).toBe(false)
    expect(sessionInDialogSyncScope(unassigned, "current", "active")).toBe(false)
    expect(sessionInDialogSyncScope(active, "current")).toBe(true)
    expect(sessionInDialogSyncScope(unassigned, "current")).toBe(true)
    expect(includeCloudSessionInDialogScope("current", "active")).toBe(true)
    expect(includeCloudSessionInDialogScope("current")).toBe(false)
    expect(includeCloudSessionInDialogScope("all", "active")).toBe(true)
    expect(
      [active, inactive, unassigned].filter((session) => sessionInDialogSyncScope(session, "all", "active")),
    ).toHaveLength(3)
  })

  test("keeps the selected Scope independent from delayed sync discovery", () => {
    const selected = { focus: "scope" as const, cwd: "cwd" as const, scope: "all" as const }
    expect(dialogSessionListScopeSelection(selected.scope)).toBe(1)

    // The internal sync scope arriving asynchronously changes the result set, not the
    // user's dialog-local selection.
    expect(sessionInDialogSyncScope({ syncSpaceID: "active" }, selected.scope)).toBe(true)
    expect(sessionInDialogSyncScope({ syncSpaceID: "active" }, selected.scope, "active")).toBe(true)
    expect(dialogSessionListScopeSelection(selected.scope)).toBe(1)

    const current = { ...selected, scope: "current" as const }
    expect(dialogSessionListScopeSelection(current.scope)).toBe(0)
    expect(sessionInDialogSyncScope({}, current.scope)).toBe(true)
    expect(sessionInDialogSyncScope({}, current.scope, "active")).toBe(false)
    expect(dialogSessionListScopeSelection(current.scope)).toBe(0)
  })
})
