import { describe, expect, test } from "bun:test"
import { redactDiagnostic } from "../../src/rexd/error"
import { sshArguments } from "../../src/rexd/ssh"

describe("Rexd SSH boundary", () => {
  test("passes manual connection fields as separate OpenSSH arguments", () => {
    expect(
      sshArguments(
        { type: "manual", host: "example", user: "hammer", port: 2222, identityFile: "/keys/id key" },
        "exec /managed/rexd --stdio",
      ),
    ).toEqual([
      "-p",
      "2222",
      "-i",
      "/keys/id key",
      "-o",
      "BatchMode=yes",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ConnectTimeout=5",
      "-o",
      "ConnectionAttempts=1",
      "-T",
      "hammer@example",
      "exec /managed/rexd --stdio",
    ])
  })

  test("does not override ssh-config host resolution or host-key policy", () => {
    const args = sshArguments({ type: "ssh-config", host: "gpu" }, "exec rexd --stdio")
    expect(args).toContain("gpu")
    expect(args).not.toContain("StrictHostKeyChecking=no")
    expect(args).not.toContain("UserKnownHostsFile=/dev/null")
  })

  test("redacts identity paths, URL credentials and private key blocks", () => {
    expect(
      redactDiagnostic(
        "failed /keys/private.pem https://host/path?token=abc\n-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----",
        ["/keys/private.pem"],
      ),
    ).not.toContain("private.pem")
    expect(redactDiagnostic("url?password=hunter2")).not.toContain("hunter2")
  })
})
