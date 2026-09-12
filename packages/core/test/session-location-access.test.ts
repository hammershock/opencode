import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { Location } from "../src/location"
import { AbsolutePath } from "../src/schema"
import { SessionLocationAccess } from "../src/session/location-access"
import { SessionSchema } from "../src/session/schema"
import { TargetRegistry } from "../src/target-registry"

const sessionID = SessionSchema.ID.make("ses_location_access")
const targetID = Location.TargetID.make("bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9")
const directory = AbsolutePath.make("/historical/worktree")
const remote = Location.Ref.make({ target: { type: "rexd", targetID }, directory })
const target: TargetRegistry.Definition = {
  id: targetID,
  status: "unverified",
  name: "gpu",
  transport: "ssh",
  connection: { type: "ssh-config", host: "gpu" },
  defaultDirectory: "/different/default",
  workspaceRoots: ["/"],
}

function session(
  location: Location.Ref,
  options: { portableTargetLabel?: string; syncSpaceID?: string; locationRevision?: number } = {},
) {
  return { id: sessionID, location, ...options } as SessionSchema.Info
}

function adapter(
  info: SessionSchema.Info,
  options: {
    targets?: readonly TargetRegistry.Definition[]
    bindings?: ReadonlyMap<string, Location.TargetID>
    foreignOwner?: boolean
    probe?: SessionLocationAccess.Adapter["probe"]
  } = {},
): SessionLocationAccess.Adapter {
  return {
    session: async () => info,
    targets: async () => options.targets ?? [],
    bindings: async () => options.bindings ?? new Map(),
    foreignOwner: async () => options.foreignOwner ?? false,
    referencedSessions: async () => [sessionID],
    probe: options.probe ?? (async () => ({ status: "ready", stages: [] })),
  }
}

describe("SessionLocationAccess", () => {
  test("permits local Sessions without probing a transport", async () => {
    let probed = false
    const location = Location.Ref.make({ target: { type: "local" }, directory: AbsolutePath.make("/local") })
    const access = SessionLocationAccess.make(
      adapter(session(location), {
        probe: async () => {
          probed = true
          return { status: "ready", stages: [] }
        },
      }),
    )

    expect(await Effect.runPromise(access.require(sessionID))).toEqual(location)
    expect(probed).toBe(false)
  })

  test("fails closed when a Session's device-local target is missing", async () => {
    const access = SessionLocationAccess.make(adapter(session(remote)))

    await expect(Effect.runPromise(access.require(sessionID))).rejects.toMatchObject({
      _tag: "SessionLocationAccess.UnresolvedError",
      status: "missing_local_target",
    })
  })

  test("uses an exact-name target when a portable target has no device-local binding", async () => {
    const access = SessionLocationAccess.make(
      adapter(session(remote, { portableTargetLabel: "lab-gpu" }), { targets: [{ ...target, name: "lab-gpu" }] }),
    )

    expect(await Effect.runPromise(access.require(sessionID))).toMatchObject({
      target: { type: "rexd", targetID },
      directory,
    })
  })

  test("recovers a legacy foreign synchronized Rexd projection as portable", async () => {
    const localTargetID = Location.TargetID.make("12c3b174-eab2-4dc3-8c2a-bf8a2b63a652")
    const access = SessionLocationAccess.make(
      adapter(
        session(
          Location.Ref.make({
            target: { type: "rexd", targetID },
            directory,
            lastKnownTargetName: "gpu",
          }),
          { syncSpaceID: "account-v2:test", locationRevision: 0 },
        ),
        {
          foreignOwner: true,
          targets: [{ ...target, id: localTargetID }],
          bindings: new Map([["gpu", localTargetID]]),
        },
      ),
    )

    expect(await Effect.runPromise(access.require(sessionID))).toMatchObject({
      target: { type: "rexd", targetID: localTargetID },
      directory,
    })
  })

  test("does not guess a locally rebound foreign target by its last-known name", async () => {
    const localTargetID = Location.TargetID.make("12c3b174-eab2-4dc3-8c2a-bf8a2b63a652")
    const access = SessionLocationAccess.make(
      adapter(
        session(
          Location.Ref.make({
            target: { type: "rexd", targetID },
            directory,
            lastKnownTargetName: "gpu",
          }),
          { syncSpaceID: "account-v2:test", locationRevision: 1 },
        ),
        { foreignOwner: true, targets: [{ ...target, id: localTargetID }] },
      ),
    )

    await expect(Effect.runPromise(access.require(sessionID))).rejects.toMatchObject({
      _tag: "SessionLocationAccess.UnresolvedError",
      status: "missing_local_target",
    })
  })

  test("validates the Session's exact historical directory instead of the target default", async () => {
    const directories: string[] = []
    const access = SessionLocationAccess.make(
      adapter(session(remote), {
        targets: [target],
        probe: async (_target, value) => {
          directories.push(value)
          return { status: "unavailable", stage: "directory", message: "directory does not exist" }
        },
      }),
    )

    await expect(Effect.runPromise(access.require(sessionID))).rejects.toMatchObject({
      _tag: "SessionLocationAccess.UnresolvedError",
      status: "target_unavailable",
      stage: "directory",
    })
    expect(directories).toEqual([directory])
  })

  test("turns resolver infrastructure failures into a formal read-only state", async () => {
    const access = SessionLocationAccess.make(
      adapter(session(remote), {
        targets: [target],
        probe: async () => {
          throw new Error("registry unavailable")
        },
      }),
    )

    expect(await Effect.runPromise(access.resolve(sessionID))).toEqual({
      status: "resolution_failed",
      message: "Session Location resolution failed",
    })
    await expect(Effect.runPromise(access.require(sessionID))).rejects.toMatchObject({
      _tag: "SessionLocationAccess.UnresolvedError",
      status: "resolution_failed",
    })
  })
})
