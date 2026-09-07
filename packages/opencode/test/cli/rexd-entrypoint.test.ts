import { afterEach, describe, expect, test } from "bun:test"
import path from "path"

const temporary: string[] = []
const installer = path.resolve(import.meta.dir, "../../script/install-rexd")

afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => Bun.$`rm -rf ${directory}`.quiet()))
})

describe("opencode-rexd installer", () => {
  test("installs independently and directly replaces the previous build", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const first = await fakeBinary(root, "first", "1.0.0-rexd.first")
    const second = await fakeBinary(root, "second", "1.0.0-rexd.second")

    await Bun.$`${installer} --binary ${first} --install-dir ${install}`
    await Bun.$`${installer} --binary ${second} --install-dir ${install}`

    expect(await Bun.$`${path.join(install, "opencode-rexd")} --version`.text()).toBe("1.0.0-rexd.second\n")
    expect(await Bun.file(path.join(install, "opencode")).exists()).toBe(false)
    expect(await Bun.file(path.join(install, "opencode-rexd.previous")).exists()).toBe(false)
  })

  test("rejects a broken candidate without changing the installed build", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const working = await fakeBinary(root, "working", "1.0.0-rexd.working")
    const broken = path.join(root, "broken")
    await Bun.write(broken, "#!/bin/sh\nexit 1\n")
    await Bun.$`chmod 755 ${broken}`

    await Bun.$`${installer} --binary ${working} --install-dir ${install}`
    const result = await Bun.$`${installer} --binary ${broken} --install-dir ${install}`.nothrow().quiet()

    expect(result.exitCode).not.toBe(0)
    expect(await Bun.$`${path.join(install, "opencode-rexd")} --version`.text()).toBe("1.0.0-rexd.working\n")
  })

  test("replaces an existing symlink entrypoint without retaining it", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const legacy = await fakeBinary(root, "legacy", "1.0.0-rexd.legacy")
    const candidate = await fakeBinary(root, "candidate", "1.0.0-rexd.candidate")
    await Bun.$`mkdir -p ${install}`
    await Bun.$`ln -s ${legacy} ${path.join(install, "opencode-rexd")}`

    await Bun.$`${installer} --binary ${candidate} --install-dir ${install}`
    expect(await Bun.$`${path.join(install, "opencode-rexd")} --version`.text()).toBe("1.0.0-rexd.candidate\n")
    expect(await Bun.file(path.join(install, "opencode-rexd.previous")).exists()).toBe(false)
  })

  test("passes deployment credentials only over stdin after candidate validation", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const calls = path.join(root, "calls")
    const candidate = path.join(root, "candidate")
    const secret = "dummy-release-secret"
    await Bun.write(
      candidate,
      `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  printf '%s\\n' '1.0.0-rexd.provision'
  exit 0
fi
printf '%s\\n' "$*" >> '${calls}'
if [ "\${1:-}" = "__deploy-provision-baidu-app" ]; then
  payload=$(dd bs=4096 count=2 2>/dev/null)
  [ "$payload" = '{"appKey":"dummy-app","secretKey":"${secret}"}' ] || exit 9
  printf '%s\\n' 'provisioned'
  exit 0
fi
exit 8
`,
    )
    await Bun.$`chmod 755 ${candidate}`
    const child = Bun.spawn([installer, "--binary", candidate, "--install-dir", install, "--provision-baidu-app"], {
      stdin: new Blob([JSON.stringify({ appKey: "dummy-app", secretKey: secret })]),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(exitCode).toBe(0)
    expect(await Bun.file(calls).text()).toBe("__deploy-provision-baidu-app\n")
    expect(stdout + stderr).not.toContain(secret)
    expect(stdout + stderr).not.toContain("dummy-app")
  })

  test("does not replace the installed build when provisioning fails", async () => {
    const root = await createFixture()
    const install = path.join(root, "install")
    const working = await fakeBinary(root, "working", "1.0.0-rexd.working")
    const broken = path.join(root, "broken-provision")
    await Bun.write(
      broken,
      '#!/bin/sh\nif [ "${1:-}" = --version ]; then echo 1.0.0-rexd.new; exit 0; fi\ncat >/dev/null\nexit 7\n',
    )
    await Bun.$`chmod 755 ${broken}`
    await Bun.$`${installer} --binary ${working} --install-dir ${install}`
    const child = Bun.spawn([installer, "--binary", broken, "--install-dir", install, "--provision-baidu-app"], {
      stdin: new Blob(['{"appKey":"dummy","secretKey":"not-printed"}']),
      stdout: "pipe",
      stderr: "pipe",
    })
    const [exitCode, output] = await Promise.all([
      child.exited,
      Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]).then((x) => x.join("")),
    ])
    expect(exitCode).not.toBe(0)
    expect(output).not.toContain("not-printed")
    expect(await Bun.$`${path.join(install, "opencode-rexd")} --version`.text()).toBe("1.0.0-rexd.working\n")
  })
})

async function createFixture() {
  const directory = await Bun.$`mktemp -d`.text().then((value) => value.trim())
  temporary.push(directory)
  return directory
}

async function fakeBinary(root: string, name: string, version: string) {
  const binary = path.join(root, name)
  await Bun.write(binary, `#!/bin/sh\nprintf '%s\\n' '${version}'\n`)
  await Bun.$`chmod 755 ${binary}`
  return binary
}
