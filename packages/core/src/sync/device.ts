export * as SyncDevice from "./device"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { NonNegativeInt } from "../schema"

export const Record = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  revision: NonNegativeInt,
  updatedAt: NonNegativeInt,
  revoked: Schema.Boolean,
})
export type Record = typeof Record.Type

export const State = Schema.Struct({
  version: Schema.Literal(1),
  devices: Schema.Array(Record),
})
export type State = typeof State.Type

export function make(filename: string) {
  let chain = Promise.resolve()
  const read = async (): Promise<State> => {
    const text = await fs.readFile(filename, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined
      throw cause
    })
    return text ? Schema.decodeUnknownSync(State)(JSON.parse(text)) : { version: 1, devices: [] }
  }
  const mutate = <A>(update: (state: State) => readonly [State, A]): Promise<A> => {
    let result!: A
    chain = chain.then(async () => {
      const [state, value] = update(await read())
      result = value
      await atomic(filename, state)
    })
    return chain.then(() => result)
  }
  const upsert = (record: Record) =>
    mutate((state) => {
      const current = state.devices.find((item) => item.id === record.id)
      // Revocation is monotonic. A stale or malicious head cannot reactivate a
      // member, and equal revisions use the stable name as a deterministic tie.
      const next = !current
        ? record
        : current.revoked
          ? current
          : record.revision > current.revision ||
              (record.revision === current.revision && record.name.localeCompare(current.name) < 0)
            ? record
            : current
      return [{ ...state, devices: [...state.devices.filter((item) => item.id !== record.id), next].sort(byID) }, next]
    })
  const revoke = (id: string, updatedAt = Date.now()) =>
    mutate((state) => {
      const current = state.devices.find((item) => item.id === id)
      if (!current) throw new Error("Unknown sync device")
      const next = { ...current, revision: current.revision + 1, updatedAt, revoked: true }
      return [{ ...state, devices: state.devices.map((item) => (item.id === id ? next : item)) }, next]
    })
  const rename = (id: string, name: string, updatedAt = Date.now()) => {
    const clean = name.trim()
    if (!clean) return Promise.reject(new Error("Device name is required"))
    return mutate((state) => {
      const current = state.devices.find((item) => item.id === id)
      if (!current || current.revoked) throw new Error("Unknown or revoked sync device")
      const next = { ...current, name: clean, revision: current.revision + 1, updatedAt }
      return [{ ...state, devices: state.devices.map((item) => (item.id === id ? next : item)) }, next]
    })
  }
  return { read, upsert, revoke, rename }
}

function byID(left: Record, right: Record) {
  return left.id.localeCompare(right.id)
}

async function atomic(filename: string, value: State) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, filename)
}
