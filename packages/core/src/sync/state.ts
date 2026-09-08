export * as SyncState from "./state"

import fs from "node:fs/promises"
import path from "node:path"
import { Schema } from "effect"
import { NonNegativeInt } from "../schema"
import { SyncSpace } from "./space"

export const IntervalSeconds = Schema.Literals([30, 60, 300])
export type IntervalSeconds = typeof IntervalSeconds.Type

export const Account = Schema.Struct({
  id: Schema.NonEmptyString,
  maskedDisplay: Schema.NonEmptyString,
})
export type Account = typeof Account.Type

export const Binding = Schema.Struct({
  accountID: Schema.NonEmptyString,
  descriptor: SyncSpace.Descriptor,
  remoteRoot: Schema.NonEmptyString,
  joinedAt: NonNegativeInt,
})
export type Binding = typeof Binding.Type

export const State = Schema.Struct({
  version: Schema.Literal(2),
  revision: NonNegativeInt,
  provider: Schema.Literal("baidu"),
  deviceID: Schema.NonEmptyString,
  deviceName: Schema.NonEmptyString,
  account: Schema.optional(Account),
  activeSpaceID: Schema.optional(Schema.NonEmptyString),
  enabled: Schema.Boolean,
  intervalSeconds: IntervalSeconds,
  spaces: Schema.Array(Binding),
})
export type State = typeof State.Type

export const Active = Schema.Struct({
  provider: Schema.Literal("baidu"),
  deviceID: Schema.NonEmptyString,
  deviceName: Schema.NonEmptyString,
  account: Account,
  namespaceID: Schema.NonEmptyString,
  name: Schema.NonEmptyString,
  encryption: SyncSpace.Encryption,
  remoteRoot: Schema.NonEmptyString,
  enabled: Schema.Boolean,
  intervalSeconds: IntervalSeconds,
})
export type Active = typeof Active.Type

export class ConflictError extends Error {
  override readonly name = "SyncState.ConflictError"
}

export class IncompatibleLocalStateError extends Error {
  override readonly name = "SyncState.IncompatibleLocalStateError"
}

export function empty(deviceName: string, deviceID: string = crypto.randomUUID()): State {
  if (!deviceName.trim()) throw new Error("Device name is required")
  return {
    version: 2,
    revision: 0,
    provider: "baidu",
    deviceID,
    deviceName: deviceName.trim(),
    enabled: false,
    intervalSeconds: 30,
    spaces: [],
  }
}

export function active(state: State): Active | undefined {
  if (!state.account || !state.activeSpaceID) return
  const binding = state.spaces.find(
    (item) => item.descriptor.namespaceID === state.activeSpaceID && item.accountID === state.account!.id,
  )
  if (!binding || !SyncSpace.compatible(binding.descriptor.protocol)) return
  return {
    provider: "baidu",
    deviceID: state.deviceID,
    deviceName: state.deviceName,
    account: state.account,
    namespaceID: binding.descriptor.namespaceID,
    name: binding.descriptor.name,
    encryption: binding.descriptor.encryption,
    remoteRoot: binding.remoteRoot,
    enabled: state.enabled,
    intervalSeconds: state.intervalSeconds,
  }
}

export function bind(state: State, binding: Binding): State {
  const previous = state.spaces.find((item) => item.descriptor.namespaceID === binding.descriptor.namespaceID)
  if (
    previous &&
    (previous.accountID !== binding.accountID || previous.descriptor.encryption !== binding.descriptor.encryption)
  )
    throw new ConflictError("A sync space cannot change account or encryption mode")
  return {
    ...state,
    spaces: [...state.spaces.filter((item) => item.descriptor.namespaceID !== binding.descriptor.namespaceID), binding],
  }
}

export function activate(state: State, namespaceID: string): State {
  if (!state.account) throw new ConflictError("Baidu account is not connected")
  const binding = state.spaces.find(
    (item) => item.descriptor.namespaceID === namespaceID && item.accountID === state.account!.id,
  )
  if (!binding) throw new ConflictError("Sync space is not joined for the current account")
  if (!SyncSpace.compatible(binding.descriptor.protocol)) throw new ConflictError("Sync space protocol is unsupported")
  return { ...state, activeSpaceID: namespaceID }
}

export function remove(state: State, namespaceID: string): State {
  return {
    ...state,
    activeSpaceID: state.activeSpaceID === namespaceID ? undefined : state.activeSpaceID,
    spaces: state.spaces.filter((item) => item.descriptor.namespaceID !== namespaceID),
  }
}

export function make(configDirectory: string) {
  const filename = path.join(configDirectory, "sync", "config.json")
  const read = async () => {
    const value = await fs.readFile(filename, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined
      throw cause
    })
    if (!value) return undefined
    const decoded: unknown = JSON.parse(value)
    if (
      decoded !== null &&
      typeof decoded === "object" &&
      Object.hasOwn(decoded, "version") &&
      (decoded as { version?: unknown }).version !== 2
    )
      throw new IncompatibleLocalStateError("Unsupported local sync state version")
    return Schema.decodeUnknownSync(State)(decoded)
  }
  const write = async (next: State, expectedRevision?: number) => {
    const current = await read()
    if (expectedRevision !== undefined && (current?.revision ?? 0) !== expectedRevision)
      throw new ConflictError("Sync configuration changed in another process")
    const value = State.make({ ...next, revision: (current?.revision ?? -1) + 1 })
    await atomicJson(filename, value)
    return value
  }
  const update = async (change: (current: State) => State, expectedRevision?: number) => {
    const current = await read()
    if (!current) throw new ConflictError("Sync configuration is not initialized")
    return write(change(current), expectedRevision ?? current.revision)
  }
  const clear = () =>
    fs.unlink(filename).catch((cause: NodeJS.ErrnoException) => cause.code === "ENOENT" || Promise.reject(cause))
  return { filename, read, write, update, clear }
}

async function atomicJson(filename: string, value: unknown) {
  await fs.mkdir(path.dirname(filename), { recursive: true })
  const temporary = `${filename}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  await fs.rename(temporary, filename)
}
