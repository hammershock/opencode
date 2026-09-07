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

function session(location: Location.Ref, portableTargetLabel?: string) {
  return { id: sessionID, location, portableTargetLabel } as SessionSchema.Info
}

function adapter(
  info: SessionSchema.Info,
  options: {
    targets?: readonly TargetRegistry.Definition[]
    bindings?: ReadonlyMap<string, Location.TargetID>
    probe?: SessionLocationAccess.Adapter["probe"]
  } = {},
): SessionLocationAccess.Adapter {
  return {
    session: async () => info,
    targets: async () => options.targets ?? [],
    bindings: async () => options.bindings ?? new Map(),
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

  test("fails closed when a portable target has no device-local binding", async () => {
    const access = SessionLocationAccess.make(adapter(session(remote, "lab-gpu"), { targets: [target] }))

    await expect(Effect.runPromise(access.require(sessionID))).rejects.toMatchObject({
      _tag: "SessionLocationAccess.UnresolvedError",
      status: "unbound_portable_target",
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
})
