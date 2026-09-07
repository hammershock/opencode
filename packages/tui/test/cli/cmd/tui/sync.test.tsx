/** @jsxImportSource @opentui/solid */
import { describe, expect, test } from "bun:test"
import { tmpdir } from "../../../fixture/fixture"
import { json, mount, wait } from "./sync-fixture"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"

function branchEvent(branch: string, workspace?: string): GlobalEvent {
  return {
    directory: "/tmp/other",
    project: "proj_test",
    workspace,
    payload: {
      id: `evt_vcs_${branch}`,
      type: "vcs.branch.updated",
      properties: { branch },
    },
  }
}

describe("tui sync", () => {
  test("refresh scopes sessions by default and lists project sessions when disabled", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, kv, sync, session } = await mount(undefined, tmp.path)

    try {
      expect(kv.get("session_directory_filter_enabled", true)).toBe(true)
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
      expect(session.at(-1)?.searchParams.get("scope")).toBeNull()
      expect(session.at(-1)?.searchParams.get("path")).toBe("packages/tui")

      kv.set("session_directory_filter_enabled", false)
      await sync.session.refresh()

      expect(session.at(-1)?.searchParams.get("scope")).toBe("project")
      expect(session.at(-1)?.searchParams.get("path")).toBeNull()
      expect(session.at(-1)?.searchParams.get("roots")).toBeNull()
    } finally {
      app.renderer.destroy()
    }
  })

  test("vcs branch updates only apply for the active workspace", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const { app, emit, project, sync } = await mount(undefined, tmp.path)

    try {
      expect(sync.data.vcs?.branch).toBe("main")

      project.workspace.set("ws_a")
      emit(branchEvent("other", "ws_b"))
      await Bun.sleep(30)

      expect(sync.data.vcs?.branch).toBe("main")

      emit(branchEvent("feature", "ws_a"))
      await wait(() => sync.data.vcs?.branch === "feature")

      expect(sync.data.vcs?.branch).toBe("feature")
    } finally {
      app.renderer.destroy()
    }
  })

  test("projects a Location rebind and persists its user-visible notice", async () => {
    await using tmp = await tmpdir()
    await Bun.write(`${tmp.path}/kv.json`, "{}")
    const session = {
      id: "ses_rebound",
      slug: "rebound",
      projectID: "proj_test",
      directory: "/old",
      title: "Rebound session",
      version: "test",
      time: { created: 1, updated: 1 },
    }
    const mounted = await mount((url) => {
      if (url.pathname === "/session") return json([session])
    }, tmp.path)

    try {
      mounted.emit({
        directory: "/new",
        project: "proj_test",
        payload: {
          id: "evt_rebound",
          type: "session.next.location.rebound",
          properties: {
            timestamp: 2,
            sessionID: session.id,
            previous: { directory: "/old" },
            location: { directory: "/new" },
            revision: 1,
          },
        },
      })
      await wait(() => mounted.sync.data.session[0]?.directory === "/new")

      expect(mounted.sync.data.session[0]).toMatchObject({ directory: "/new", time: { updated: 2 } })
      expect(mounted.kv.get(`session_location_changed:${session.id}`)).toEqual({
        revision: 1,
        previous: { directory: "/old" },
        location: { directory: "/new" },
      })
    } finally {
      mounted.app.renderer.destroy()
    }
  })
})
