import { describe, expect, test } from "bun:test"
import { sessionListLocation, sessionListMatches } from "../../src/component/session-list-location"

describe("Session list location presentation", () => {
  test("always presents and searches the canonical local directory", () => {
    const session = { title: "Build", directory: "/Users/hammer/workspace/opencode" }
    expect(sessionListLocation(session).label).toBe("/Users/hammer/workspace/opencode")
    expect(sessionListMatches(session, "workspace/opencode")).toBe(true)
  })

  test("presents and searches remote target, directory, and optional device", () => {
    const session = {
      title: "Training",
      directory: "/stale",
      location: { directory: "/mnt/models/run", target: { type: "rexd", name: "a100-2gpu" } },
      sync: { deviceName: "mywindows" },
    }
    expect(sessionListLocation(session).label).toBe("a100-2gpu · /mnt/models/run · mywindows")
    expect(sessionListMatches(session, "a100-2gpu")).toBe(true)
    expect(sessionListMatches(session, "mywindows")).toBe(true)
  })

  test("uses the persisted target name from the current Session DTO", () => {
    const session = {
      title: "Remote",
      directory: "/srv/repo",
      target: { type: "rexd", targetID: "0199-target" },
      lastKnownTargetName: "gpu-lab",
      metadata: { deviceName: "macbook" },
    }
    expect(sessionListLocation(session).label).toBe("gpu-lab · /srv/repo · macbook")
  })

  test("presents and searches cloud-only portable target and source device metadata", () => {
    const session = {
      title: "Synced",
      directory: "/srv/cloud-project",
      targetLabel: "gpu-cloud",
      sourceDeviceID: "device-windows",
    }
    expect(sessionListLocation(session).label).toBe("gpu-cloud · /srv/cloud-project · device-windows")
    expect(sessionListMatches(session, "gpu-cloud")).toBe(true)
    expect(sessionListMatches(session, "device-windows")).toBe(true)
  })

  test.each([
    ["missing_local_target", "unresolved"],
    ["unbound_portable_target", "unresolved"],
    ["target_unavailable", "unavailable"],
  ] as const)("keeps %s locations visible as %s", (locationStatus, expected) => {
    const session = { title: "Recovered", directory: "/repo", targetName: "removed", locationStatus }
    expect(sessionListLocation(session).status).toBe(expected)
    expect(sessionListLocation(session).label).toContain(expected)
    expect(sessionListMatches(session, expected)).toBe(true)
  })
})
