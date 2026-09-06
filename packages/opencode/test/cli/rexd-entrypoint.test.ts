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
