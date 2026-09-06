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

  test("portable labels require an explicit local binding", async () => {
    const result = await SessionLocationRebinding.resolve({
      sessionID,
      portable: { label: "lab-gpu", directory: "/work" },
      targets: [definition(targetID, "lab-gpu")],
      bindings: new Map(),
      referencedSessions: async () => [sessionID],
      probe: async () => ({ status: "ready", stages: [] }),
    })
    expect(result).toMatchObject({ status: "unbound_portable_target", portableTargetLabel: "lab-gpu" })
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
