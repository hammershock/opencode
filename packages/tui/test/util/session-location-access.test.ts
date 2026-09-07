import { describe, expect, test } from "bun:test"
import { localEditorDirectory, permitsRouteLocationActions } from "../../src/util/session-location-access"

describe("unresolved Session location capabilities", () => {
  test("denies location actions until a Session is explicitly resolved", () => {
    expect(permitsRouteLocationActions({ name: "home" })).toBe(true)
    expect(permitsRouteLocationActions({ name: "session", params: { sessionID: "ses_pending" } })).toBe(false)
    expect(
      permitsRouteLocationActions({
        name: "session",
        params: { sessionID: "ses_readonly", accessMode: "read-only", resolution: "missing_local_target" },
      }),
    ).toBe(false)
    expect(
      permitsRouteLocationActions({
        name: "session",
        params: { sessionID: "ses_ready", accessMode: "read-write" },
      }),
    ).toBe(true)
  })

  test("connects a local editor only from the resolved effective Location", () => {
    expect(localEditorDirectory({ status: "resolution_failed", message: "offline" })).toBeUndefined()
    expect(
      localEditorDirectory({
        status: "resolved",
        location: { directory: "/remote", target: { type: "rexd", targetID: "target" } },
      }),
    ).toBeUndefined()
    expect(localEditorDirectory({ status: "resolved", location: { directory: "/local" } })).toBe("/local")
  })
})
