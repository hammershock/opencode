import { describe, expect, test } from "bun:test"
import { remoteRequest } from "../../src/context/sdk"

describe("remote request status classification", () => {
  test("tracks forced target refreshes", () => {
    expect(remoteRequest("http://localhost/api/target/target-1/refresh", { method: "POST" })).toMatchObject({
      area: "Target",
      operation: "test connection",
      phase: "SSH",
      inspectResponse: true,
    })
  })

  test("tracks Session target resolution through its full server-side prepare", () => {
    expect(remoteRequest("http://localhost/api/session/session-1/target-resolution")).toMatchObject({
      area: "Target",
      operation: "open session target",
      phase: "SSH and Rexd",
      inspectResponse: true,
      successStatus: "resolved",
    })
  })
})
