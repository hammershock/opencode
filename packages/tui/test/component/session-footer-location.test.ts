import { describe, expect, test } from "bun:test"
import { sessionFooterLocation } from "../../src/component/session-footer-location"

describe("Session footer location", () => {
  test("shows local target and the Agent working directory", () => {
    expect(
      sessionFooterLocation({
        session: { directory: "/Users/hammer/workspace/opencode", target: { type: "local" } },
        fallbackDirectory: "/stale/controller/path",
        home: "/Users/hammer",
        branch: "dev",
      }),
    ).toEqual({
      target: "local",
      directory: "~/workspace/opencode:dev",
      label: "local · ~/workspace/opencode:dev",
    })
  })

  test("shows the persisted Rexd target name instead of its device-local ID", () => {
    expect(
      sessionFooterLocation({
        session: {
          directory: "/home/ma-user/workspace/hanmo",
          target: { type: "rexd", targetID: "device-local-id" },
          lastKnownTargetName: "a100-2gpu",
        },
        fallbackDirectory: "/Users/hammer",
        home: "/Users/hammer",
      }).label,
    ).toBe("a100-2gpu · /home/ma-user/workspace/hanmo")
  })

  test("uses the active Location directory for the prompt footer", () => {
    const result = sessionFooterLocation({
      session: {
        directory: "/home/ma-user/workspace",
        target: { type: "rexd", targetID: "device-local-id" },
        lastKnownTargetName: "a100-2gpu",
      },
      fallbackDirectory: "/fallback",
      directory: "/home/ma-user/workspace/opencode",
      home: "/home/ma-user",
    })

    expect(result.label).toBe("a100-2gpu · ~/workspace/opencode")
  })
})
