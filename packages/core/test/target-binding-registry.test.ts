import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Location } from "../src/location"
import { TargetBindingRegistry } from "../src/target-binding-registry"

const first = Location.TargetID.make("bbbf7f19-ab10-4f5d-94ab-fd9225b8f3e9")
const second = Location.TargetID.make("abaf7f19-ab10-4f5d-94ab-fd9225b8f3e9")

describe("device-local portable target bindings", () => {
  test("binds only after optimistic revision validation and persists mode 0600", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-binding-"))
    try {
      const registry = TargetBindingRegistry.make(directory)
      const before = await registry.load()
      const after = await registry.bind("lab-gpu", first, before.revision)
      expect(after.bindings.get("lab-gpu")).toBe(first)
      expect((await fs.stat(after.path)).mode & 0o777).toBe(0o600)
      await expect(registry.bind("lab-gpu", second, before.revision)).rejects.toMatchObject({
        _tag: "TargetBindingRegistry.RevisionConflictError",
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })

  test("explicit binding replaces a label but never matches by target name", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-binding-"))
    try {
      const registry = TargetBindingRegistry.make(directory)
      const initial = await registry.load()
      const one = await registry.bind("same-name-is-not-a-binding", first, initial.revision)
      const two = await registry.bind("same-name-is-not-a-binding", second, one.revision)
      expect(two.bindings.get("same-name-is-not-a-binding")).toBe(second)
      const empty = await registry.unbind("same-name-is-not-a-binding", two.revision)
      expect(empty.bindings.size).toBe(0)
      await expect(registry.unbind("same-name-is-not-a-binding", two.revision)).rejects.toMatchObject({
        _tag: "TargetBindingRegistry.RevisionConflictError",
      })
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
})
