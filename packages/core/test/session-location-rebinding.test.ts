import { describe, expect, test } from "bun:test"
import { Location } from "../src/location"
import { SessionLocationRebinding } from "../src/session-location-rebinding"
import { SessionSchema } from "../src/session/schema"
import { AbsolutePath } from "../src/schema"

const sessionID = SessionSchema.ID.make("ses_rebind")
const targetID = Location.TargetID.make("bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9")
const otherTargetID = Location.TargetID.make("abaf7f19-ab10-4f5d-94ab-fd9225b8f3e9")
const local = Location.Ref.make({ target: { type: "local" }, directory: AbsolutePath.make("/old") })
const remote = Location.Ref.make({ target: { type: "rexd", targetID }, directory: AbsolutePath.make("/new") })

describe("Session target resolution", () => {
  test("never guesses a missing target by name", async () => {
    const result = await SessionLocationRebinding.resolve({
      sessionID,
      location: Location.Ref.make({ ...remote, lastKnownTargetName: "gpu" }),
      targets: [definition(otherTargetID, "gpu")],
      bindings: new Map(),
      referencedSessions: async () => [sessionID],
      probe: async () => ({ status: "ready", stages: [] }),
    })
    expect(result).toMatchObject({ status: "missing_local_target", missingTargetID: targetID })
  })

  test("portable labels resolve an exact-name local target and validate the Session directory", async () => {
    const directories: string[] = []
    const result = await SessionLocationRebinding.resolve({
      sessionID,
      portable: { label: "lab-gpu", directory: "/work" },
      targets: [definition(targetID, "lab-gpu")],
      bindings: new Map(),
      referencedSessions: async () => [sessionID],
      probe: async (_target, directory) => {
        directories.push(directory)
        return { status: "ready", stages: [] }
      },
    })
    expect(result).toMatchObject({
      status: "resolved",
      location: { target: { type: "rexd", targetID }, directory: "/work" },
    })
    expect(directories).toEqual(["/work"])
  })

  test("keeps unmatched portable labels unresolved", async () => {
    const result = await SessionLocationRebinding.resolve({
      sessionID,
      portable: { label: "lab-gpu", directory: "/work" },
      targets: [definition(targetID, "another-gpu")],
      bindings: new Map(),
      referencedSessions: async () => [sessionID],
      probe: async () => ({ status: "ready", stages: [] }),
    })
    expect(result).toMatchObject({ status: "unbound_portable_target", portableTargetLabel: "lab-gpu" })
  })

  test("prefers an explicit binding over an exact-name local target", async () => {
    const result = await SessionLocationRebinding.resolve({
      sessionID,
      portable: { label: "lab-gpu", directory: "/work" },
      targets: [definition(targetID, "lab-gpu"), definition(otherTargetID, "bound-elsewhere")],
      bindings: new Map([["lab-gpu", otherTargetID]]),
      referencedSessions: async () => [sessionID],
      probe: async () => ({ status: "ready", stages: [] }),
    })
    expect(result).toMatchObject({ status: "resolved", location: { target: { targetID: otherTargetID } } })
  })

  test("reports a configured but unavailable target separately", async () => {
    const result = await SessionLocationRebinding.resolve({
      sessionID,
      location: remote,
      targets: [definition(targetID, "gpu")],
      bindings: new Map(),
      referencedSessions: async () => [],
      probe: async () => ({ status: "unavailable", stage: "handshake", message: "offline" }),
    })
    expect(result).toMatchObject({ status: "target_unavailable", stage: "handshake", message: "offline" })
  })
})

describe("Session location rebind transaction", () => {
  test("validates, rechecks revision and idle state, commits, then invalidates", async () => {
    const calls: string[] = []
    const record = { sessionID, location: local, locationRevision: 3 }
    const workflow = SessionLocationRebinding.make({
      withMutationLock: async (_id, run) => run(),
      read: async () => {
        calls.push("read")
        return record
      },
      blockers: async () => {
        calls.push("idle")
        return []
      },
      validateCandidate: async (location) => {
        calls.push("validate")
        return { location, preparedEnvironment: { generation: 1 } }
      },
      commit: async () => {
        calls.push("commit")
        return { revision: 4 }
      },
      invalidateRuntime: async () => {
        calls.push("invalidate")
        return ["old lease close failed"]
      },
    })
    expect(await workflow.rebind({ sessionID, expectedRevision: 3, destination: remote })).toEqual({
      status: "rebound",
      revision: 4,
      warnings: ["old lease close failed"],
    })
    expect(calls).toEqual(["read", "idle", "validate", "read", "idle", "commit", "invalidate"])
  })

  test("rejects every active subsystem before candidate validation", async () => {
    const blockers: SessionLocationRebinding.Blocker[] = [
      "agent_turn",
      "queued_turn",
      "tool_execution",
      "process_execution",
      "user_shell",
      "permission",
      "question",
      "terminal_pty",
      "session_mutation",
      "location_rebind",
      "sync_replay",
    ]
    let validated = false
    const workflow = SessionLocationRebinding.make({
      withMutationLock: async (_id, run) => run(),
      read: async () => ({ sessionID, location: local, locationRevision: 1 }),
      blockers: async () => blockers,
      validateCandidate: async (location) => {
        validated = true
        return { location, preparedEnvironment: undefined }
      },
      commit: async () => ({ revision: 2 }),
      invalidateRuntime: async () => [],
    })
    await expect(workflow.rebind({ sessionID, expectedRevision: 1, destination: remote })).rejects.toMatchObject({
      _tag: "SessionLocationRebinding.SessionNotIdleError",
      blockers,
    })
    expect(validated).toBe(false)
  })

  test("does not commit if revision changes during candidate validation", async () => {
    let reads = 0
    let committed = false
    const workflow = SessionLocationRebinding.make({
      withMutationLock: async (_id, run) => run(),
      read: async () => ({ sessionID, location: local, locationRevision: ++reads === 1 ? 1 : 2 }),
      blockers: async () => [],
      validateCandidate: async (location) => ({ location, preparedEnvironment: undefined }),
      commit: async () => {
        committed = true
        return { revision: 3 }
      },
      invalidateRuntime: async () => [],
    })
    await expect(workflow.rebind({ sessionID, expectedRevision: 1, destination: remote })).rejects.toMatchObject({
      _tag: "SessionLocationRebinding.RevisionConflictError",
    })
    expect(committed).toBe(false)
  })

  test("identical destination is unchanged without validation", async () => {
    let validated = false
    const workflow = SessionLocationRebinding.make({
      withMutationLock: async (_id, run) => run(),
      read: async () => ({ sessionID, location: local, locationRevision: 2 }),
      blockers: async () => [],
      validateCandidate: async (location) => {
        validated = true
        return { location, preparedEnvironment: undefined }
      },
      commit: async () => ({ revision: 3 }),
      invalidateRuntime: async () => [],
    })
    expect(await workflow.rebind({ sessionID, expectedRevision: 2, destination: local })).toEqual({
      status: "unchanged",
      revision: 2,
      warnings: [],
    })
    expect(validated).toBe(false)
  })
})

describe("Session recovery safety", () => {
  const input = {
    name: "gpu",
    transport: "ssh" as const,
    connection: { type: "ssh-config" as const, host: "gpu" },
    workspaceRoots: ["/work"],
  }

  test("read-only unresolved Sessions deny every location-dependent operation", () => {
    expect(SessionLocationRebinding.permits("read-only", "history.read")).toBe(true)
    expect(SessionLocationRebinding.permits("read-only", "metadata.read")).toBe(true)
    for (const operation of [
      "prompt",
      "user_shell",
      "agent_tool",
      "terminal",
      "filesystem",
      "location_mutation",
    ] as const) {
      expect(SessionLocationRebinding.permits("read-only", operation)).toBe(false)
    }
  })

  test("restores the exact missing ID for the confirmed batch without changing Session locations", async () => {
    const second = SessionSchema.ID.make("ses_second")
    const calls: string[] = []
    const recovery = SessionLocationRebinding.makeRecovery({
      referencedSessions: async () => [sessionID, second],
      validateTargetInput: async () => {
        calls.push("target.validate")
      },
      restoreMissingTarget: async (request) => {
        calls.push(`restore:${request.targetID}`)
        return definition(request.targetID, request.target.name)
      },
      validateSessionLocation: async (id) => {
        calls.push(`session.validate:${id}`)
        if (id === second) throw new Error("directory missing")
      },
      setPortableBinding: async () => ({ revision: "next" }),
      readPortableBindingRevision: async () => "binding",
      publishGlobalDeletion: async () => {},
      removeLocalProjection: async () => {},
    })
    const result = await recovery.restoreMissing({
      targetID,
      target: input,
      expectedSessionIDs: [second, sessionID],
      expectedRegistryRevision: "registry",
      locations: new Map([
        [sessionID, remote],
        [second, Location.Ref.make({ ...remote, directory: AbsolutePath.make("/missing") })],
      ]),
    })
    expect(result.target.id).toBe(targetID)
    expect(result.resolvedSessionIDs).toEqual([sessionID])
    expect(result.failedSessionIDs).toEqual([second])
    expect(calls).toEqual([
      "target.validate",
      `restore:${targetID}`,
      `session.validate:${sessionID}`,
      `session.validate:${second}`,
    ])
  })

  test("rejects a changed recovery batch before mutation", async () => {
    let changed = false
    const recovery = SessionLocationRebinding.makeRecovery({
      referencedSessions: async () => [sessionID, SessionSchema.ID.make("ses_new")],
      validateTargetInput: async () => {},
      restoreMissingTarget: async () => {
        changed = true
        return definition(targetID, "gpu")
      },
      validateSessionLocation: async () => {},
      setPortableBinding: async () => ({ revision: "next" }),
      readPortableBindingRevision: async () => "binding",
      publishGlobalDeletion: async () => {},
      removeLocalProjection: async () => {},
    })
    await expect(
      recovery.restoreMissing({
        targetID,
        target: input,
        expectedSessionIDs: [sessionID],
        expectedRegistryRevision: "registry",
        locations: new Map([[sessionID, remote]]),
      }),
    ).rejects.toMatchObject({ _tag: "SessionLocationRebinding.RecoveryScopeChangedError" })
    expect(changed).toBe(false)
  })

  test("validates a portable batch before publishing one device-local binding", async () => {
    const calls: string[] = []
    const recovery = SessionLocationRebinding.makeRecovery({
      referencedSessions: async () => [sessionID],
      validateTargetInput: async () => {},
      restoreMissingTarget: async () => definition(targetID, "gpu"),
      validateSessionLocation: async () => {
        calls.push("validate")
      },
      setPortableBinding: async () => {
        calls.push("bind")
        return { revision: "next" }
      },
      readPortableBindingRevision: async () => "current",
      publishGlobalDeletion: async () => {},
      removeLocalProjection: async () => {},
    })
    expect(
      await recovery.bindPortable({
        portableTargetLabel: "lab-gpu",
        targetID,
        expectedSessionIDs: [sessionID],
        expectedBindingRevision: "current",
        locations: new Map([[sessionID, remote]]),
      }),
    ).toEqual({ revision: "next", resolvedSessionIDs: [sessionID] })
    expect(calls).toEqual(["validate", "bind"])
  })

  test("checks every portable Session for activity before and after validation", async () => {
    const calls: string[] = []
    let checks = 0
    const recovery = SessionLocationRebinding.makeRecovery({
      referencedSessions: async () => [sessionID],
      validateTargetInput: async () => {},
      restoreMissingTarget: async () => definition(targetID, "gpu"),
      validateSessionLocation: async () => {
        calls.push("validate")
      },
      assertSessionsIdle: async (ids) => {
        calls.push(`idle:${ids.join(",")}`)
        if (++checks === 2) throw new SessionLocationRebinding.SessionNotIdleError({ blockers: ["sync_replay"] })
      },
      setPortableBinding: async () => {
        calls.push("bind")
        return { revision: "next" }
      },
      readPortableBindingRevision: async () => "current",
      publishGlobalDeletion: async () => {},
      removeLocalProjection: async () => {},
    })

    await expect(
      recovery.bindPortable({
        portableTargetLabel: "lab-gpu",
        targetID,
        expectedSessionIDs: [sessionID],
        expectedBindingRevision: "current",
        locations: new Map([[sessionID, remote]]),
      }),
    ).rejects.toMatchObject({ _tag: "SessionLocationRebinding.SessionNotIdleError" })
    expect(calls).toEqual([`idle:${sessionID}`, "validate", `idle:${sessionID}`])
  })

  test("publishes a global tombstone before removing the local projection", async () => {
    const calls: string[] = []
    const recovery = SessionLocationRebinding.makeRecovery({
      referencedSessions: async () => [],
      validateTargetInput: async () => {},
      restoreMissingTarget: async () => definition(targetID, "gpu"),
      validateSessionLocation: async () => {},
      setPortableBinding: async () => ({ revision: "next" }),
      readPortableBindingRevision: async () => "current",
      publishGlobalDeletion: async () => {
        calls.push("tombstone")
      },
      removeLocalProjection: async () => {
        calls.push("projection")
      },
    })
    await recovery.deleteGlobally(sessionID)
    expect(calls).toEqual(["tombstone", "projection"])
  })
})

function definition(id: Location.TargetID, name: string) {
  return {
    id,
    status: "unverified" as const,
    name,
    transport: "ssh" as const,
    connection: { type: "ssh-config" as const, host: name },
    workspaceRoots: ["/"],
  }
}
