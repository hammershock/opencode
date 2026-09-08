import { describe, expect, test } from "bun:test"
import { remoteFailureDetail } from "../../src/context/remote-status"

describe("remoteFailureDetail", () => {
  test("keeps provider detail without exposing low-level retryability", () => {
    expect(
      remoteFailureDetail({
        stage: "segment",
        operation: "upload",
        kind: "invalid-response",
        retryable: false,
        message: "Baidu Netdisk create failed: response did not match the documented schema",
      }),
    ).toBe(
      "segment · upload · invalid-response · Baidu Netdisk create failed: response did not match the documented schema",
    )
  })
})
