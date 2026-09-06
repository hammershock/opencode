import { describe, expect, test } from "bun:test"
import { RexdError } from "../../src/rexd/error"
import { REXD_ARTIFACTS, REXD_BASELINE_VERSION } from "../../src/rexd/manifest"
import { detectRemotePlatform, prepareManagedRexd } from "../../src/rexd/prepare"
import type { RexdTarget } from "../../src/rexd/ssh"

const target: RexdTarget = {
  id: "target-1",
  connection: { type: "ssh-config", host: "fixture" },
  workspaceRoots: ["/work", "/data/a'b"],
}

describe("managed Rexd prepare", () => {
  test.each([
    ["x86_64", "linux-amd64"],
    ["aarch64", "linux-arm64"],
  ] as const)("detects Linux %s including WSL userspace", async (architecture, platform) => {
    const detected = await detectRemotePlatform(target, undefined, {
      run: async () => ({
        stdout: `Linux\n${architecture}\n/home/hammer\n/home/hammer/.local/share\n/home/hammer/.config\nwsl\n`,
        stderr: "",
      }),
    })
    expect(detected).toEqual({
      platform,
      home: "/home/hammer",
      dataHome: "/home/hammer/.local/share",
      configHome: "/home/hammer/.config",
      wsl: true,
    })
  })

  test("rejects unsupported systems before running installation", async () => {
    let calls = 0
    await expect(
      prepareManagedRexd(target, undefined, {
        run: async () => {
          calls++
          return { stdout: "Darwin\narm64\n/Users/test\n/data\n/config\nlinux\n", stderr: "" }
        },
      }),
    ).rejects.toMatchObject({ phase: "unsupported-platform" })
    expect(calls).toBe(1)
  })

  test.each(["ready", "installed"] as const)("accepts idempotent installer status %s", async (status) => {
    const scripts: string[] = []
    const result = await prepareManagedRexd(target, undefined, {
      run: async (_connection, script) => {
        scripts.push(script)
        if (scripts.length === 1) {
          return { stdout: "Linux\nx86_64\n/home/hammer\n/data\n/config\nlinux\n", stderr: "" }
        }
        return { stdout: `${status}\n`, stderr: "" }
      },
    })
    expect(result.installed).toBe(status === "installed")
    expect(result.binary).toBe(`/data/opencode/rexd/${REXD_BASELINE_VERSION}/rexd`)
    expect(scripts[1]).toContain(REXD_ARTIFACTS["linux-amd64"].sha256)
    expect(scripts[1]).toContain('mkdir "$lock"')
    expect(scripts[1]).toContain('chmod 0600 "$config.next"')
    expect(scripts[1]).not.toContain("sudo")
    expect(scripts[1]).not.toContain("releases/latest")
    expect(scripts[1]).not.toContain("$HOME/.config/rexd")
    const syntax = Bun.spawn(["sh", "-n"], { stdin: new Blob([scripts[1]!]), stdout: "ignore", stderr: "pipe" })
    expect(await syntax.exited, await new Response(syntax.stderr).text()).toBe(0)
  })

  test.each([
    ["download", true],
    ["checksum", false],
    ["install", true],
  ] as const)("classifies the %s phase", async (phase, retryable) => {
    let calls = 0
    await expect(
      prepareManagedRexd(target, undefined, {
        run: async () => {
          calls++
          if (calls === 1) return { stdout: "Linux\nx86_64\n/home/hammer\n/data\n/config\nlinux\n", stderr: "" }
          throw new RexdError("ssh", "bootstrap failed", true, "failed", `OPENCODE_REXD_PHASE=${phase} detail`)
        },
      }),
    ).rejects.toMatchObject({ phase, retryable })
  })
})
