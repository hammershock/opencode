import { describe, expect, test } from "bun:test"
import { chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
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
    ["Linux", "x86_64", "linux-amd64", "wsl"],
    ["Linux", "aarch64", "linux-arm64", "linux"],
    ["Darwin", "x86_64", "darwin-amd64", "darwin"],
    ["Darwin", "arm64", "darwin-arm64", "darwin"],
  ] as const)("detects %s %s as %s", async (system, architecture, platform, environment) => {
    const detected = await detectRemotePlatform(target, undefined, {
      run: async () => ({
        stdout: `${system}\n${architecture}\n/home/hammer\n/home/hammer/.local/share\n/home/hammer/.config\n${environment}\n`,
        stderr: "",
      }),
    })
    expect(detected).toEqual({
      platform,
      home: "/home/hammer",
      dataHome: "/home/hammer/.local/share",
      configHome: "/home/hammer/.config",
      wsl: environment === "wsl",
    })
  })

  test("rejects unsupported systems before running installation", async () => {
    let calls = 0
    await expect(
      prepareManagedRexd(target, undefined, {
        run: async () => {
          calls++
          return { stdout: "FreeBSD\narm64\n/Users/test\n/data\n/config\nfreebsd\n", stderr: "" }
        },
      }),
    ).rejects.toMatchObject({ phase: "unsupported-platform" })
    expect(calls).toBe(1)
  })

  test("bounds the initial SSH environment probe independently from installation", async () => {
    await expect(
      detectRemotePlatform(target, undefined, {
        detectTimeoutMs: 5,
        run: async () => new Promise(() => undefined),
      }),
    ).rejects.toMatchObject({
      phase: "ssh",
      message: "SSH connection timed out after 0.005 seconds",
    })
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
    expect(scripts[1]).toContain('chmod 0600 "$config_next"')
    expect(scripts[1]!.indexOf('"$binary_next" -h')).toBeLessThan(scripts[1]!.indexOf('mv "$binary_next" "$binary"'))
    expect(scripts[1]).not.toContain("sudo")
    expect(scripts[1]).not.toContain("releases/latest")
    expect(scripts[1]).not.toContain("$HOME/.config/rexd")
    const syntax = Bun.spawn(["sh", "-n"], { stdin: new Blob([scripts[1]!]), stdout: "ignore", stderr: "pipe" })
    expect(await syntax.exited, await new Response(syntax.stderr).text()).toBe(0)
  })

  test("falls back to a control-device verified SSH upload when the target cannot reach GitHub", async () => {
    let calls = 0
    let uploaded: Uint8Array | undefined
    let remoteCommand = ""
    const payload = new Uint8Array([1, 2, 3])
    const result = await prepareManagedRexd(target, undefined, {
      run: async () => {
        calls++
        if (calls === 1) return { stdout: "Linux\nx86_64\n/home/hammer\n/data\n/config\nlinux\n", stderr: "" }
        throw new RexdError("ssh", "bootstrap failed", true, "failed", "OPENCODE_REXD_PHASE=download failed")
      },
      download: async () => payload,
      verify: (value, expected) => {
        expect(value).toBe(payload)
        expect(expected).toBe(REXD_ARTIFACTS["linux-amd64"].sha256)
      },
      upload: async (_connection, command, value) => {
        remoteCommand = command
        uploaded = value
        return { stdout: "installed\n", stderr: "" }
      },
    })
    expect(result.installed).toBe(true)
    expect(uploaded).toBe(payload)
    expect(remoteCommand).toStartWith("sh -c ")
    expect(remoteCommand).toContain(REXD_ARTIFACTS["linux-amd64"].sha256)
    expect(remoteCommand).not.toContain("sudo")
  })

  test("rejects an invalid downloaded candidate before replacing canonical files", async () => {
    const fixture = await installationFixture("invalid")
    try {
      await seedCanonical(fixture)
      const before = await canonicalSnapshot(fixture)
      const result = await runInstaller(await capturedInstallScript(fixture), fixture)

      expect(result.exitCode).toBe(78)
      expect(result.stderr).toContain("OPENCODE_REXD_PHASE=install binary invalid")
      expect(await canonicalSnapshot(fixture)).toEqual(before)
      expect(await stagedPaths(fixture)).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test("commits a fresh downloaded candidate and reports ready on the next run", async () => {
    const fixture = await installationFixture("valid")
    try {
      const script = await capturedInstallScript(fixture)
      const installed = await runInstaller(script, fixture)
      const ready = await runInstaller(script, fixture)

      expect(installed).toMatchObject({ exitCode: 0, stdout: "installed\n", stderr: "" })
      expect(ready).toMatchObject({ exitCode: 0, stdout: "ready\n", stderr: "" })
      expect(await Bun.file(fixture.marker).text()).toBe(REXD_ARTIFACTS["linux-amd64"].sha256)
      expect((await stat(fixture.binary)).mode & 0o777).toBe(0o755)
      expect((await stat(fixture.config)).mode & 0o777).toBe(0o600)
      expect(await stagedPaths(fixture)).toEqual([])
    } finally {
      await rm(fixture.root, { recursive: true, force: true })
    }
  })

  test.each([
    ["existing", true, "5"],
    ["fresh", false, "2"],
  ] as const)(
    "rolls an uploaded candidate commit failure back to the %s canonical set",
    async (_, existing, failMove) => {
      const fixture = await installationFixture("valid")
      try {
        if (existing) await seedCanonical(fixture)
        const before = await canonicalSnapshot(fixture)
        const command = await capturedUploadCommand(fixture)
        const result = await runInstaller(command, fixture, {
          input: await Bun.file(fixture.archive).bytes(),
          failMove,
        })

        expect(result.exitCode).toBe(79)
        expect(result.stderr).toContain("OPENCODE_REXD_PHASE=install commit failed")
        expect(await canonicalSnapshot(fixture)).toEqual(before)
        expect(await stagedPaths(fixture)).toEqual([])
      } finally {
        await rm(fixture.root, { recursive: true, force: true })
      }
    },
  )

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
        download: async () => {
          throw new RexdError("download", "control download failed", true)
        },
      }),
    ).rejects.toMatchObject({ phase, retryable })
  })
})

type InstallationFixture = Awaited<ReturnType<typeof installationFixture>>

async function installationFixture(candidate: "valid" | "invalid") {
  const root = await mkdtemp(path.join(tmpdir(), "opencode-rexd-transaction-"))
  const source = path.join(root, "source")
  const shims = path.join(root, "shims")
  const binary = path.join(root, "data", "opencode", "rexd", REXD_BASELINE_VERSION, "rexd")
  const marker = `${binary}.sha256`
  const config = path.join(root, "config", "opencode", "rexd", "config.toml")
  const archive = path.join(root, REXD_ARTIFACTS["linux-amd64"].name)
  await mkdir(source, { recursive: true })
  await mkdir(shims, { recursive: true })
  await Bun.write(
    path.join(source, "rexd-linux-amd64"),
    candidate === "valid" ? "#!/bin/sh\nexit 0\n" : "#!/bin/sh\nexit 1\n",
  )
  await chmod(path.join(source, "rexd-linux-amd64"), 0o755)
  const archiveProcess = Bun.spawn(["tar", "-czf", archive, "-C", source, "rexd-linux-amd64"], {
    stdout: "ignore",
    stderr: "pipe",
  })
  expect(await archiveProcess.exited, await new Response(archiveProcess.stderr).text()).toBe(0)
  await executable(
    path.join(shims, "curl"),
    `#!/bin/sh
output=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "-o" ]; then shift; output="$1"; fi
  shift
done
cp "$FIXTURE_ARCHIVE" "$output"
`,
  )
  await executable(
    path.join(shims, "sha256sum"),
    `#!/bin/sh
printf '%s  %s\n' "$FIXTURE_CHECKSUM" "$1"
`,
  )
  await executable(
    path.join(shims, "mv"),
    `#!/bin/sh
count="$(cat "$FIXTURE_MV_STATE" 2>/dev/null || printf 0)"
count=$((count + 1))
printf '%s' "$count" >"$FIXTURE_MV_STATE"
if [ -n "\${FIXTURE_FAIL_MOVE:-}" ] && [ "$count" = "$FIXTURE_FAIL_MOVE" ]; then exit 1; fi
exec /bin/mv "$@"
`,
  )
  return {
    root,
    shims,
    binary,
    marker,
    config,
    archive,
    moveState: path.join(root, "move-state"),
  }
}

async function seedCanonical(fixture: InstallationFixture) {
  await mkdir(path.dirname(fixture.binary), { recursive: true })
  await mkdir(path.dirname(fixture.config), { recursive: true })
  await Bun.write(fixture.binary, "#!/bin/sh\nprintf 'previous\\n'\n")
  await Bun.write(fixture.marker, "previous-checksum")
  await Bun.write(fixture.config, "previous-config\n")
  await chmod(fixture.binary, 0o701)
  await chmod(fixture.marker, 0o640)
  await chmod(fixture.config, 0o604)
}

async function canonicalSnapshot(fixture: InstallationFixture) {
  return Promise.all([fixture.binary, fixture.marker, fixture.config].map(snapshot))
}

async function snapshot(file: string) {
  return stat(file)
    .then(async (metadata) => ({ content: await readFile(file, "utf8"), mode: metadata.mode & 0o777 }))
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
}

async function stagedPaths(fixture: InstallationFixture) {
  return Array.fromAsync(new Bun.Glob("**/*.{next,previous}.*").scan({ cwd: fixture.root })).then((files) =>
    files.sort(),
  )
}

async function capturedInstallScript(fixture: InstallationFixture) {
  const scripts: string[] = []
  await prepareManagedRexd(target, undefined, {
    run: async (_connection, script) => {
      scripts.push(script)
      if (scripts.length === 1) return platformResult(fixture)
      return { stdout: "installed\n", stderr: "" }
    },
  })
  return scripts[1]!
}

async function capturedUploadCommand(fixture: InstallationFixture) {
  let calls = 0
  let command = ""
  await prepareManagedRexd(target, undefined, {
    run: async () => {
      calls++
      if (calls === 1) return platformResult(fixture)
      throw new RexdError("ssh", "download failed", true, "failed", "OPENCODE_REXD_PHASE=download failed")
    },
    download: async () => Bun.file(fixture.archive).bytes(),
    verify: () => undefined,
    upload: async (_connection, value) => {
      command = value
      return { stdout: "installed\n", stderr: "" }
    },
  })
  return command
}

function platformResult(fixture: InstallationFixture) {
  return {
    stdout: `Linux\nx86_64\n${fixture.root}\n${path.join(fixture.root, "data")}\n${path.join(fixture.root, "config")}\nlinux\n`,
    stderr: "",
  }
}

async function runInstaller(
  script: string,
  fixture: InstallationFixture,
  options: { input?: Uint8Array; failMove?: string } = {},
) {
  const child = options.input
    ? Bun.spawn(["sh", "-c", script], {
        stdin: new Blob([Uint8Array.from(options.input)]),
        stdout: "pipe",
        stderr: "pipe",
        env: installerEnvironment(fixture, options.failMove),
      })
    : Bun.spawn(["sh"], {
        stdin: new Blob([script]),
        stdout: "pipe",
        stderr: "pipe",
        env: installerEnvironment(fixture, options.failMove),
      })
  return {
    exitCode: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  }
}

function installerEnvironment(fixture: InstallationFixture, failMove?: string) {
  return {
    ...process.env,
    PATH: `${fixture.shims}:${process.env.PATH ?? ""}`,
    FIXTURE_ARCHIVE: fixture.archive,
    FIXTURE_CHECKSUM: REXD_ARTIFACTS["linux-amd64"].sha256,
    FIXTURE_MV_STATE: fixture.moveState,
    FIXTURE_FAIL_MOVE: failMove ?? "",
  }
}

async function executable(file: string, content: string) {
  await Bun.write(file, content)
  await chmod(file, 0o755)
}
