import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { SyncDevice } from "@opencode-ai/core/sync/device"

describe("SyncDevice", () => {
  test("persists deterministic device revisions and monotonic revocation", async () => {
    const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", "sync-device-"))
    const file = path.join(directory, "sync", "state.json")
    const first = SyncDevice.make(file)
    await first.upsert({ id: "mac", name: "Mac", revision: 1, updatedAt: 1, revoked: false })
    await first.upsert({ id: "mac", name: "Stale", revision: 0, updatedAt: 2, revoked: false })
    expect((await first.read()).devices[0]?.name).toBe("Mac")
    await first.revoke("mac", 3)
    await first.upsert({ id: "mac", name: "Resurrect", revision: 99, updatedAt: 4, revoked: false })

    const afterRestart = await SyncDevice.make(file).read()
    expect(afterRestart.devices[0]).toMatchObject({ name: "Mac", revoked: true, revision: 2 })
    expect(await fs.readFile(file, "utf8")).not.toContain("bindings")
  })
})
