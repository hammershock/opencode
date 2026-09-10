import { describe, expect, test } from "bun:test"
import { sessionListFooter, sessionListLocation, sessionListMatches } from "../../src/component/session-list-location"

describe("Session list location presentation", () => {
  test("always presents and searches the canonical local directory", () => {
    const session = { title: "Build", directory: "/Users/hammer/workspace/opencode" }
    expect(sessionListLocation(session).label).toBe("local · /Users/hammer/workspace/opencode")
    expect(sessionListMatches(session, "workspace/opencode")).toBe(true)
  })

  test("uses the same stable label for an explicit local target", () => {
    expect(
      sessionListLocation({
        directory: "/stale",
        location: { directory: "/Users/hammer/workspace/opencode", target: { type: "local" } },
      }).label,
    ).toBe("local · /Users/hammer/workspace/opencode")
  })

  test("treats a foreign device's local target as its portable target name", () => {
    expect(
      sessionListLocation({
        directory: "/Users/hammer/workspace/opencode",
        target: { type: "local" },
        portableTargetLabel: "mymac",
      }).label,
    ).toBe("mymac · /Users/hammer/workspace/opencode")
  })

  test("presents and searches remote target, directory, and optional device", () => {
    const session = {
      title: "Training",
      directory: "/stale",
      location: { directory: "/mnt/models/run", target: { type: "rexd", name: "a100-2gpu" } },
      sync: { deviceName: "mywindows" },
    }
    expect(sessionListLocation(session).label).toBe("a100-2gpu · /mnt/models/run")
    expect(sessionListLocation(session).device).toBe("mywindows")
    expect(sessionListMatches(session, "a100-2gpu")).toBe(true)
    expect(sessionListMatches(session, "mywindows")).toBe(true)
  })

  test("uses the persisted target name after a Session is rebound", () => {
    const session = {
      title: "Remote",
      directory: "/srv/repo",
      target: { type: "rexd", targetID: "0199-target" },
      lastKnownTargetName: "gpu-lab",
      metadata: { deviceName: "macbook" },
    }
    expect(sessionListLocation(session).label).toBe("gpu-lab · /srv/repo")
  })

  test("presents and searches cloud-only portable target and source device metadata", () => {
    const session = {
      title: "Synced",
      directory: "/srv/cloud-project",
      targetLabel: "gpu-cloud",
      sourceDeviceID: "device-windows",
    }
    expect(sessionListLocation(session).label).toBe("gpu-cloud · /srv/cloud-project")
    expect(sessionListMatches(session, "gpu-cloud")).toBe(true)
    expect(sessionListMatches(session, "device-windows")).toBe(true)
  })

  test.each(["missing_local_target", "unbound_portable_target", "target_unavailable"] as const)(
    "does not expose %s target state in the session list",
    (locationStatus) => {
      const session = { title: "Recovered", directory: "/repo", targetName: "removed", locationStatus }
      expect(sessionListLocation(session).label).toBe("removed · /repo")
      expect(sessionListMatches(session, locationStatus)).toBe(false)
    },
  )

  test("prefers portable labels and never exposes a device-local target ID", () => {
    const portable = sessionListLocation({
      directory: "/srv/repo",
      target: { type: "rexd", targetID: "0199-device-local" },
      lastKnownTargetName: "local-alias",
      portableTargetLabel: "gpu-lab",
    })
    expect(portable.label).toBe("gpu-lab · /srv/repo")
    expect(portable.search).not.toContain("0199-device-local")

    const fallback = sessionListLocation({
      directory: "/srv/repo",
      target: { type: "rexd", targetID: "0199-device-local" },
    })
    expect(fallback.label).toBe("remote · /srv/repo")
    expect(fallback.search).not.toContain("0199-device-local")
  })

  test.each([1, 12, 28, 48, 72])("keeps sync status at the right edge within a %i-column footer", (width) => {
    const location = sessionListLocation({
      directory: "/a/very/long/workspace/location/with/a/project-name",
      targetLabel: "portable-gpu-target",
      sourceDeviceID: "mywindows",
      locationStatus: "target_unavailable",
    })
    const row = sessionListFooter(location, "! partial", width)
    expect(row.text.length).toBeLessThanOrEqual(width)
    if (width > row.status.length) expect(row.text.endsWith(row.status)).toBe(true)
    if (width === 1) expect(row.text).toBe("…")
    if (width > 1 && width <= row.status.length) expect(row.text.endsWith(row.status.slice(-(width - 1)))).toBe(true)
    expect(row.full).toBe(
      "portable-gpu-target · /a/very/long/workspace/location/with/a/project-name · mywindows · ! partial",
    )
  })

  test("keeps a healthy sync status in the shared status vocabulary", () => {
    const row = sessionListFooter(sessionListLocation({ directory: "/repo" }), "● ready", 40)
    expect(row.text).toBe("local · /repo · ● ready")
    expect(row.status).toBe("● ready")
  })
})
