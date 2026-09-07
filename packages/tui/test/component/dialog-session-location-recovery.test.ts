import { describe, expect, test } from "bun:test"
import {
  allowsRecoveryRebind,
  portableBindingRequest,
  portableTargetIsUnbound,
  recoveryScopeOptions,
  resolutionDescription,
} from "../../src/component/dialog-session-location-recovery"

describe("Session Location recovery", () => {
  test("portable binding uses the reviewed binding snapshot and exact Session scope", () => {
    const request = portableBindingRequest(
      {
        status: "unbound_portable_target",
        portableTargetLabel: "gpu",
        directory: "/workspace",
        referencedSessionIDs: ["ses_b", "ses_a"],
      },
      "target-local",
      "binding-revision-before-dialog",
    )
    expect(request).toEqual({
      portableTargetLabel: "gpu",
      targetID: "target-local",
      expectedRevision: "binding-revision-before-dialog",
      expectedSessionIDs: ["ses_b", "ses_a"],
    })
    expect(portableTargetIsUnbound({}, "gpu")).toBe(true)
    expect(portableTargetIsUnbound({ gpu: "someone-else" }, "gpu")).toBe(false)
  })

  test("describes every unresolved state without hiding read-only recovery context", () => {
    expect(
      resolutionDescription({
        status: "missing_local_target",
        location: { target: { type: "rexd", targetID: "gone" }, directory: "/work" },
        missingTargetID: "gone",
        lastKnownTargetName: "mywindows",
        referencedSessionIDs: ["ses_1"],
      }),
    ).toContain("mywindows")
    expect(
      resolutionDescription({
        status: "target_unavailable",
        location: { target: { type: "rexd", targetID: "target" }, directory: "/work" },
        target: {
          id: "target",
          status: "unverified",
          name: "gpu",
          transport: "ssh",
          connection: { type: "ssh-config", host: "gpu" },
          workspaceRoots: ["/"],
        },
        stage: "directory",
        message: "missing",
      }),
    ).toBe("directory · missing")
  })

  test("lists every affected Session title and full ID", () => {
    expect(
      recoveryScopeOptions([
        { id: "ses_first", title: "First" },
        { id: "ses_second", title: "Second" },
      ]),
    ).toEqual([
      {
        title: "First",
        description: "ses_first",
        value: { type: "session", id: "ses_first" },
        category: "Affected Sessions",
      },
      {
        title: "Second",
        description: "ses_second",
        value: { type: "session", id: "ses_second" },
        category: "Affected Sessions",
      },
      { title: "Continue", value: { type: "continue" }, category: "Action" },
    ])
  })

  test("gates force rebind for every unresolved reason", () => {
    const unavailable = {
      status: "target_unavailable" as const,
      location: { target: { type: "local" as const }, directory: "/work" },
      target: {
        id: "target",
        status: "unverified" as const,
        name: "gpu",
        transport: "ssh" as const,
        connection: { type: "ssh-config" as const, host: "gpu" },
        workspaceRoots: ["/"],
      },
      stage: "directory" as const,
      message: "missing",
    }
    expect(allowsRecoveryRebind(unavailable, false)).toBe(false)
    expect(allowsRecoveryRebind(unavailable, true)).toBe(true)
    expect(allowsRecoveryRebind({ status: "resolution_failed", message: "failed" }, true)).toBe(true)
    expect(allowsRecoveryRebind({ status: "resolved", location: unavailable.location }, true)).toBe(false)
  })
})
