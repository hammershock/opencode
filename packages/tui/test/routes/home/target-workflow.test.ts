import { describe, expect, test } from "bun:test"
import {
  executionTargetActions,
  openExecutionTargetAction,
  remoteInitialDirectory,
  validateDestination,
} from "../../../src/routes/home/target-workflow"

describe("QuickStart target preflight", () => {
  test("uses the configured remote directory before the inspected home", () => {
    expect(remoteInitialDirectory({ defaultDirectory: "/srv/project" }, "/home/remote")).toBe("/srv/project")
    expect(remoteInitialDirectory({}, "/home/remote")).toBe("/home/remote")
  })

  test("opens the existing target manager in direct add mode", () => {
    expect(executionTargetActions).toEqual([
      { title: "Add target…", value: "add", category: "Actions" },
      { title: "Manage targets…", value: "manage", category: "Actions" },
    ])
    const opened: Array<"manage" | "add" | undefined> = []
    openExecutionTargetAction("add", (mode) => opened.push(mode))
    openExecutionTargetAction("manage", (mode) => opened.push(mode))
    expect(opened).toEqual(["add", "manage"])
  })

  test("local validates the directory without preparing a target", async () => {
    const calls: string[] = []
    const result = await validateDestination({
      target: { type: "local" },
      directory: "/work",
      prepare: async () => {
        calls.push("prepare")
        return { status: "ready", stages: [] }
      },
      validate: async (location) => {
        calls.push(`validate:${location.directory}`)
      },
    })
    expect(calls).toEqual(["validate:/work"])
    expect(result).toEqual({ target: { type: "local" }, directory: "/work" })
  })

  test("remote prepare happens before target-side directory validation", async () => {
    const calls: string[] = []
    const result = await validateDestination({
      target: { type: "rexd", targetID: "target-1", name: "mywindows" },
      directory: "/workspace/project",
      prepare: async (targetID) => {
        calls.push(`prepare:${targetID}`)
        return { status: "ready", stages: ["connect", "daemon"] }
      },
      validate: async (location) => {
        calls.push(`validate:${location.target.type}:${location.directory}`)
      },
    })
    expect(calls).toEqual(["prepare:target-1", "validate:rexd:/workspace/project"])
    expect(result.lastKnownTargetName).toBe("mywindows")
  })

  test("a failed prepare never validates or falls back to local", async () => {
    let validated = false
    await expect(
      validateDestination({
        target: { type: "rexd", targetID: "target-1", name: "offline" },
        directory: "/work",
        prepare: async () => ({ status: "unavailable", stage: "handshake", message: "offline" }),
        validate: async () => {
          validated = true
        },
      }),
    ).rejects.toThrow("handshake: offline")
    expect(validated).toBe(false)
  })
})
