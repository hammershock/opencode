import { afterEach, describe, expect, test } from "bun:test"
import path from "path"

const temporary: string[] = []
const installer = path.resolve(import.meta.dir, "../../script/install-transit")

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => Bun.$`rm -rf ${directory}`.quiet()))
})

describe("opencode-transit installer", () => {
  test("installs independently and directly replaces the previous build", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const first = await fakeBinary(root, "first", "1.0.0-transit.0+first")
    const second = await fakeBinary(root, "second", "1.0.0-transit.0+second")

    await Bun.$`${installer} --binary ${first} --install-dir ${install}`
    await Bun.$`${installer} --binary ${second} --install-dir ${install}`

    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe("1.0.0-transit.0+second\n")
    expect(await Bun.file(path.join(install, "opencode")).exists()).toBe(false)
    expect(await Bun.file(path.join(install, "opencode-transit.previous")).exists()).toBe(false)
    const legacy = Bun.spawn([path.join(install, "opencode-rexd"), "--version"], { stdout: "pipe", stderr: "pipe" })
    const [legacyExit, legacyStdout, legacyStderr] = await Promise.all([
      legacy.exited,
      new Response(legacy.stdout).text(),
      new Response(legacy.stderr).text(),
    ])
    expect(legacyExit).toBe(0)
    expect(legacyStdout).toBe("1.0.0-transit.0+second\n")
    expect(legacyStderr).toContain("opencode-rexd is deprecated; use opencode-transit")
  })

  test("signs a macOS candidate before replacing the installed build", async () => {
    if (process.platform !== "darwin") return
    const root = await createFixture()
    const install = path.join(root, "install")
    const candidate = await fakeBinary(root, "signed", "1.0.0-transit.0+signed")
    const commands = path.join(root, "commands")
    const calls = path.join(root, "codesign-calls")
    await Bun.$`mkdir -p ${commands}`
    await Bun.write(
      path.join(commands, "codesign"),
      `#!/bin/sh
printf '%s\n' "$*" >> "$CODESIGN_CALLS"
exit 0
`,
    )
    await Bun.$`chmod 755 ${path.join(commands, "codesign")}`

    const result = Bun.spawn(
      [installer, "--binary", candidate, "--install-dir", install, "--codesign-identity", "Test Identity"],
      {
        env: { ...process.env, CODESIGN_CALLS: calls, PATH: `${commands}:${process.env.PATH}` },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    expect(await result.exited).toBe(0)
    const signed = await Bun.file(calls).text()
    expect(signed).toContain("--force --sign Test Identity --identifier ai.opencode.transit --timestamp=none")
    expect(signed).toContain("--verify --strict")
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe("1.0.0-transit.0+signed\n")
  })

  test("rejects a broken candidate without changing the installed build", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const working = await fakeBinary(root, "working", "1.0.0-transit.0+working")
    const broken = path.join(root, "broken")
    await Bun.write(broken, "#!/bin/sh\nexit 1\n")
    await Bun.$`chmod 755 ${broken}`

    await Bun.$`${installer} --binary ${working} --install-dir ${install}`
    const result = await Bun.$`${installer} --binary ${broken} --install-dir ${install}`.nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe("1.0.0-transit.0+working\n")
  })

  test("installs a paired binary and build manifest", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const firstCommit = "a".repeat(40)
    const secondCommit = "b".repeat(40)
    const firstVersion = `1.0.0-transit.0+${firstCommit.slice(0, 12)}`
    const secondVersion = `1.0.0-transit.0+${secondCommit.slice(0, 12)}`
    const first = await fakeBinary(root, "first", firstVersion)
    const second = await fakeBinary(root, "second", secondVersion)
    const firstManifest = await fakeManifest(root, "first", firstVersion, firstCommit)
    const secondManifest = await fakeManifest(root, "second", secondVersion, secondCommit)

    await Bun.$`${installer} --binary ${first} --manifest ${firstManifest} --install-dir ${install}`
    await Bun.$`${installer} --binary ${second} --manifest ${secondManifest} --install-dir ${install}`

    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${secondVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).json()).toEqual({
      product: "OpenCode Transit",
      entrypoint: "opencode-transit",
      version: secondVersion,
      upstreamVersion: "1.0.0",
      commit: secondCommit,
      dirty: false,
      target: "opencode-darwin-arm64",
      builtAt: "2026-09-11T00:00:00.000Z",
    })
  })

  test("rejects a mismatched manifest version without changing the installed pair", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const candidateCommit = "b".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const candidateVersion = `1.0.0-transit.0+${candidateCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const candidate = await fakeBinary(root, "candidate", candidateVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const mismatchedManifest = await fakeManifest(root, "mismatch", "1.0.0-transit.0+cccccccccccc", candidateCommit)

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    const installedManifest = await Bun.file(path.join(install, "opencode-transit.build.json")).text()
    const result =
      await Bun.$`${installer} --binary ${candidate} --manifest ${mismatchedManifest} --install-dir ${install}`
        .nothrow()
        .quiet()

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Build manifest is invalid")
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${workingVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).text()).toBe(installedManifest)
  })

  test("rejects a mismatched manifest commit without changing the installed pair", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const candidateCommit = "b".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const candidateVersion = `1.0.0-transit.0+${candidateCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const candidate = await fakeBinary(root, "candidate", candidateVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const mismatchedManifest = await fakeManifest(root, "mismatch", candidateVersion, "c".repeat(40))

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    const installedManifest = await Bun.file(path.join(install, "opencode-transit.build.json")).text()
    const result =
      await Bun.$`${installer} --binary ${candidate} --manifest ${mismatchedManifest} --install-dir ${install}`
        .nothrow()
        .quiet()

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Build manifest is invalid")
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${workingVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).text()).toBe(installedManifest)
  })

  test("keeps entrypoint validation before replacing the installed pair", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const candidateCommit = "b".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const candidateVersion = `1.0.0-transit.0+${candidateCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const candidate = await fakeBinary(root, "candidate", candidateVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const wrongEntrypoint = await fakeManifest(
      root,
      "wrong-entrypoint",
      candidateVersion,
      candidateCommit,
      false,
      "opencode",
    )

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    const installedManifest = await Bun.file(path.join(install, "opencode-transit.build.json")).text()
    const result =
      await Bun.$`${installer} --binary ${candidate} --manifest ${wrongEntrypoint} --install-dir ${install}`
        .nothrow()
        .quiet()

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Build manifest is invalid")
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${workingVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).text()).toBe(installedManifest)
  })

  test("rejects malformed and dirty-state mismatched manifests through the candidate validator", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const commit = "a".repeat(40)
    const version = `1.0.0-transit.0+${commit.slice(0, 12)}`
    const candidate = await fakeBinary(root, "candidate", version)
    const malformed = path.join(root, "malformed.build.json")
    const wrongDirty = await fakeManifest(root, "wrong-dirty", version, commit, true)
    await Bun.write(malformed, "not-json")

    const malformedResult =
      await Bun.$`${installer} --binary ${candidate} --manifest ${malformed} --install-dir ${install}`.nothrow().quiet()
    const dirtyResult =
      await Bun.$`${installer} --binary ${candidate} --manifest ${wrongDirty} --install-dir ${install}`
        .nothrow()
        .quiet()

    expect(malformedResult.exitCode).not.toBe(0)
    expect(dirtyResult.exitCode).not.toBe(0)
    expect(await Bun.file(path.join(install, "opencode-transit")).exists()).toBe(false)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).exists()).toBe(false)
  })

  test("restores the previous pair when the installed candidate smoke check fails", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const candidateCommit = "b".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const candidateVersion = `1.0.0-transit.0+${candidateCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const candidateManifest = await fakeManifest(root, "candidate", candidateVersion, candidateCommit)
    const candidate = path.join(root, "candidate")
    const calls = path.join(root, "candidate-version-calls")
    await Bun.write(
      candidate,
      `#!/bin/sh
if [ "\${1:-}" = --version ]; then
  count=$(cat '${calls}' 2>/dev/null || printf 0)
  count=$((count + 1))
  printf '%s' "$count" > '${calls}'
  [ "$count" -eq 1 ] || exit 7
  printf '%s\\n' '${candidateVersion}'
  exit 0
fi
if [ "\${1:-}" = __deploy-verify-build-manifest ]; then cat >/dev/null; exit 0; fi
exit 8
`,
    )
    await Bun.$`chmod 755 ${candidate}`

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    const installedManifest = await Bun.file(path.join(install, "opencode-transit.build.json")).text()
    const result =
      await Bun.$`${installer} --binary ${candidate} --manifest ${candidateManifest} --install-dir ${install}`
        .nothrow()
        .quiet()

    expect(result.exitCode).not.toBe(0)
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${workingVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).text()).toBe(installedManifest)
    expect(await Array.fromAsync(new Bun.Glob(".opencode-transit.backup*").scan({ cwd: install }))).toEqual([])
  })

  test("restores the previous pair when the installed manifest smoke check fails", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const candidateCommit = "b".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const candidateVersion = `1.0.0-transit.0+${candidateCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const candidateManifest = await fakeManifest(root, "candidate", candidateVersion, candidateCommit)
    const candidate = path.join(root, "candidate")
    const calls = path.join(root, "candidate-manifest-calls")
    await Bun.write(
      candidate,
      `#!/usr/bin/env bun
import { verifyBuildManifestFromStream } from ${JSON.stringify(
        path.resolve(import.meta.dir, "../../src/cli/cmd/deploy-verify-build-manifest.ts"),
      )}

if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(`${candidateVersion}\n`)})
  process.exit(0)
}
if (process.argv[2] === "__deploy-verify-build-manifest") {
  const count = Number(await Bun.file(${JSON.stringify(calls)}).text().catch(() => "0")) + 1
  await Bun.write(${JSON.stringify(calls)}, String(count))
  if (count === 1) {
    await verifyBuildManifestFromStream(process.stdin, ${JSON.stringify(candidateVersion)})
    process.exit(0)
  }
  process.exit(73)
}
process.exit(1)
`,
    )
    await Bun.$`chmod 755 ${candidate}`

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    const installedManifest = await Bun.file(path.join(install, "opencode-transit.build.json")).text()
    const result =
      await Bun.$`${installer} --binary ${candidate} --manifest ${candidateManifest} --install-dir ${install}`
        .nothrow()
        .quiet()

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.toString()).toContain("Installed manifest smoke check failed")
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${workingVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).text()).toBe(installedManifest)
    expect(await Array.fromAsync(new Bun.Glob(".opencode-transit.backup*").scan({ cwd: install }))).toEqual([])
  })

  test("restores the previous pair when manifest replacement fails", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const candidateCommit = "b".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const candidateVersion = `1.0.0-transit.0+${candidateCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const candidate = await fakeBinary(root, "candidate", candidateVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const candidateManifest = await fakeManifest(root, "candidate", candidateVersion, candidateCommit)
    const commandDirectory = path.join(root, "commands")
    const moveCount = path.join(root, "move-count")
    await Bun.$`mkdir -p ${commandDirectory}`
    await Bun.write(
      path.join(commandDirectory, "mv"),
      `#!/bin/sh
count=$(cat "$MOVE_COUNT" 2>/dev/null || printf 0)
count=$((count + 1))
printf '%s' "$count" > "$MOVE_COUNT"
[ "$count" -ne 2 ] || exit 71
exec /bin/mv "$@"
`,
    )
    await Bun.$`chmod 755 ${path.join(commandDirectory, "mv")}`

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    const installedManifest = await Bun.file(path.join(install, "opencode-transit.build.json")).text()
    const child = Bun.spawn(
      [installer, "--binary", candidate, "--manifest", candidateManifest, "--install-dir", install],
      {
        env: {
          ...process.env,
          MOVE_COUNT: moveCount,
          PATH: `${commandDirectory}:${process.env.PATH}`,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const exitCode = await child.exited

    expect(exitCode).not.toBe(0)
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(`${workingVersion}\n`)
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).text()).toBe(installedManifest)
    expect(await Array.fromAsync(new Bun.Glob(".opencode-transit.backup*").scan({ cwd: install }))).toEqual([])
  })

  test("removes an old manifest after a successful manifest-free install", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const workingCommit = "a".repeat(40)
    const workingVersion = `1.0.0-transit.0+${workingCommit.slice(0, 12)}`
    const working = await fakeBinary(root, "working", workingVersion)
    const workingManifest = await fakeManifest(root, "working", workingVersion, workingCommit)
    const candidate = await fakeBinary(root, "candidate", "1.0.0-transit.0+manifest-free")

    await Bun.$`${installer} --binary ${working} --manifest ${workingManifest} --install-dir ${install}`
    await Bun.$`${installer} --binary ${candidate} --install-dir ${install}`

    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe(
      "1.0.0-transit.0+manifest-free\n",
    )
    expect(await Bun.file(path.join(install, "opencode-transit.build.json")).exists()).toBe(false)
  })

  test("replaces an existing symlink entrypoint without retaining it", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const legacy = await fakeBinary(root, "legacy", "1.0.0-transit.0+legacy")
    const candidate = await fakeBinary(root, "candidate", "1.0.0-transit.0+candidate")
    await Bun.$`mkdir -p ${install}`
    await Bun.$`ln -s ${legacy} ${path.join(install, "opencode-transit")}`

    await Bun.$`${installer} --binary ${candidate} --install-dir ${install}`
    expect(await Bun.$`${path.join(install, "opencode-transit")} --version`.text()).toBe("1.0.0-transit.0+candidate\n")
    expect(await Bun.file(path.join(install, "opencode-transit.previous")).exists()).toBe(false)
  })
})

async function createFixture() {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  temporary.push(directory)
  return directory
}

async function fakeBinary(root: string, name: string, version: string) {
  const binary = path.join(root, name)
  await Bun.write(
    binary,
    `#!/usr/bin/env bun
import { verifyBuildManifestFromStream } from ${JSON.stringify(
      path.resolve(import.meta.dir, "../../src/cli/cmd/deploy-verify-build-manifest.ts"),
    )}

if (process.argv[2] === "--version") {
  process.stdout.write(${JSON.stringify(`${version}\n`)})
  process.exit(0)
}
if (process.argv[2] === "__deploy-verify-build-manifest") {
  await verifyBuildManifestFromStream(process.stdin, ${JSON.stringify(version)})
  process.exit(0)
}
process.exit(1)
`,
  )
  await Bun.$`chmod 755 ${binary}`
  return binary
}

async function fakeManifest(
  root: string,
  name: string,
  version: string,
  commit: string,
  dirty = false,
  entrypoint = "opencode-transit",
) {
  const manifest = path.join(root, `${name}.build.json`)
  await Bun.write(
    manifest,
    JSON.stringify({
      product: "OpenCode Transit",
      entrypoint,
      version,
      upstreamVersion: version.slice(0, version.indexOf("-transit.")),
      commit,
      dirty,
      target: "opencode-darwin-arm64",
      builtAt: "2026-09-11T00:00:00.000Z",
    }),
  )
  return manifest
}
