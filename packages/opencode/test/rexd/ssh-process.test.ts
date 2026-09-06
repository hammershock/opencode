import { expect, test } from "bun:test"
import path from "node:path"
import { runSshScript } from "../../src/rexd/ssh"
import { tmpdir } from "../fixture/fixture"

test("SSH script cancellation terminates and reaps the child process", async () => {
  await using tmp = await tmpdir()
  const executable = path.join(tmp.path, "ssh-fixture")
  const ready = path.join(tmp.path, "ready")
  const closed = path.join(tmp.path, "closed")
  await Bun.write(
    executable,
    `#!/bin/sh
touch '${ready}'
trap "touch '${closed}'; exit 0" TERM INT
while :; do :; done
`,
  )
  await Bun.spawn(["chmod", "0700", executable]).exited

  const controller = new AbortController()
  const running = runSshScript({ type: "ssh-config", host: "fixture" }, "ignored", controller.signal, executable)
  await waitForFile(ready)
  controller.abort()
  await expect(running).rejects.toMatchObject({ phase: "cancelled" })
  await waitForFile(closed)
})

async function waitForFile(file: string) {
  const timeout = Date.now() + 3_000
  while (!(await Bun.file(file).exists())) {
    if (Date.now() > timeout) throw new Error(`Timed out waiting for ${path.basename(file)}`)
    await Bun.sleep(10)
  }
}
