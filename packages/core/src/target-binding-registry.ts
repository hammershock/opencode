export * as TargetBindingRegistry from "./target-binding-registry"

import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Schema } from "effect"
import { Context, Effect, Layer } from "effect"
import { Global } from "./global"
import { makeGlobalNode } from "./effect/app-node"
import { Location } from "./location"
import { Flock } from "./util/flock"

export type Snapshot = {
  readonly path: string
  readonly revision: string
  readonly bindings: ReadonlyMap<string, Location.TargetID>
}

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "TargetBindingRegistry.RevisionConflictError",
  { expected: Schema.String, actual: Schema.String },
) {}

export class InvalidLabelError extends Schema.TaggedErrorClass<InvalidLabelError>()(
  "TargetBindingRegistry.InvalidLabelError",
  {
    label: Schema.String,
  },
) {}

export function make(directory: string) {
  const filepath = path.join(directory, "target-bindings.json")

  const load = async (): Promise<Snapshot> => {
    const text = await readText(filepath)
    const decoded = JSON.parse(text) as { version?: unknown; bindings?: unknown }
    if (
      decoded.version !== 1 ||
      !decoded.bindings ||
      typeof decoded.bindings !== "object" ||
      Array.isArray(decoded.bindings)
    )
      throw new Error("Invalid target binding registry")
    const bindings = new Map<string, Location.TargetID>()
    for (const [label, value] of Object.entries(decoded.bindings)) {
      validateLabel(label)
      bindings.set(label, Location.TargetID.make(value))
    }
    return { path: filepath, revision: digest(text), bindings }
  }

  const bind = async (label: string, targetID: Location.TargetID, expectedRevision: string) => {
    validateLabel(label)
    return Flock.withLock(`target-binding-registry:${filepath}`, async () => {
      const before = await load()
      if (before.revision !== expectedRevision)
        throw new RevisionConflictError({ expected: expectedRevision, actual: before.revision })
      const bindings = Object.fromEntries(
        [...before.bindings, [label, targetID]].sort(([a], [b]) => a.localeCompare(b)),
      )
      const text = JSON.stringify({ version: 1, bindings }, null, 2) + "\n"
      await atomicWrite(filepath, text)
      return load()
    })
  }

  const unbind = async (label: string, expectedRevision: string) => {
    validateLabel(label)
    return Flock.withLock(`target-binding-registry:${filepath}`, async () => {
      const before = await load()
      if (before.revision !== expectedRevision)
        throw new RevisionConflictError({ expected: expectedRevision, actual: before.revision })
      const bindings = new Map(before.bindings)
      bindings.delete(label)
      const text =
        JSON.stringify(
          { version: 1, bindings: Object.fromEntries([...bindings].sort(([a], [b]) => a.localeCompare(b))) },
          null,
          2,
        ) + "\n"
      await atomicWrite(filepath, text)
      return load()
    })
  }

  return { load, bind, unbind }
}

export type Interface = ReturnType<typeof make>
export class Service extends Context.Service<Service, Interface>()("@opencode/TargetBindingRegistry") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    return Service.of(make(global.config))
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node] })

function validateLabel(label: string) {
  if (!label.trim() || label !== label.trim() || label.length > 128 || /[\u0000-\u001f]/.test(label))
    throw new InvalidLabelError({ label })
}

async function readText(filepath: string) {
  return fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return '{\n  "version": 1,\n  "bindings": {}\n}\n'
    throw error
  })
}

async function atomicWrite(filepath: string, text: string) {
  await fs.mkdir(path.dirname(filepath), { recursive: true, mode: 0o700 })
  const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: 0o600 })
    await fs.rename(temporary, filepath)
  } finally {
    await fs.unlink(temporary).catch(() => {})
  }
}

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex")
}
