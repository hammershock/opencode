import { describe, expect, test } from "bun:test"
import {
  portableBindingRequest,
  portableTargetIsUnbound,
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
})
