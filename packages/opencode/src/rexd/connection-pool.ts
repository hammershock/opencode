import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { Context, Effect, Layer } from "effect"
import { connectRexd, validateRexdDirectory, type RexdLease } from "./connection"
import type { RexdTarget } from "./ssh"

export type Handle = {
  readonly lease: RexdLease
  readonly release: () => Promise<void>
}

export interface Interface {
  readonly acquire: (
    target: RexdTarget,
    options: { readonly directory?: string; readonly clientVersion: string; readonly signal?: AbortSignal },
  ) => Promise<Handle>
  readonly close: () => Promise<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/RexdConnectionPool") {}

type Entry = {
  readonly connection: Promise<RexdLease>
  users: number
  timer?: ReturnType<typeof setTimeout>
  removeClose?: () => void
  closed: boolean
}

export function make(
  dependencies: {
    readonly connect?: typeof connectRexd
    readonly validate?: typeof validateRexdDirectory
    readonly idleMs?: number
  } = {},
): Interface {
  const entries = new Map<string, Entry>()
  const connect = dependencies.connect ?? connectRexd
  const validate = dependencies.validate ?? validateRexdDirectory
  const idleMs = dependencies.idleMs ?? 2 * 60_000

  const drop = (key: string, entry: Entry) => {
    if (entry.closed) return
    entry.closed = true
    if (entries.get(key) === entry) entries.delete(key)
    if (entry.timer) clearTimeout(entry.timer)
    entry.removeClose?.()
  }

  const evict = async (key: string, entry: Entry) => {
    if (entry.closed) return
    drop(key, entry)
    await entry.connection.then((lease) => lease.close()).catch(() => undefined)
  }

  const create = (key: string, target: RexdTarget, options: { readonly clientVersion: string }) => {
    let entry: Entry
    // An acquire signal belongs to that caller, not to the shared transport. If
    // it cancelled the connection, one closing panel could interrupt every
    // Location currently sharing the lease.
    const connection = connect(target, { clientVersion: options.clientVersion }).then(
      (lease) => {
        entry.removeClose = lease.client.onClose(() => drop(key, entry))
        return lease
      },
      (error) => {
        drop(key, entry)
        throw error
      },
    )
    entry = { connection, users: 0, closed: false }
    entries.set(key, entry)
    return entry
  }

  const acquire: Interface["acquire"] = async (target, options) => {
    const key = connectionKey(target, options.clientVersion)
    const entry = entries.get(key) ?? create(key, target, options)
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = undefined
    entry.users++
    const release = async () => {
      if (entry.closed) return
      entry.users--
      if (entry.users !== 0) return
      entry.timer = setTimeout(() => void evict(key, entry), idleMs)
      entry.timer.unref?.()
    }
    const lease = await entry.connection.catch(async (error) => {
      await release()
      throw error
    })
    if (options.directory) {
      await validate(target.id, lease, options.directory, options.signal).catch(async (error) => {
        await release()
        throw error
      })
    }
    let released = false
    return {
      lease,
      release: async () => {
        if (released) return
        released = true
        await release()
      },
    }
  }

  return {
    acquire,
    close: () => Promise.allSettled([...entries].map(([key, entry]) => evict(key, entry))).then(() => undefined),
  }
}

export const node = makeGlobalNode({
  service: Service,
  layer: Layer.effect(
    Service,
    Effect.acquireRelease(
      Effect.sync(() => make()),
      (pool) => Effect.promise(() => pool.close()),
    ),
  ),
  deps: [],
})

function connectionKey(target: RexdTarget, clientVersion: string) {
  const connection =
    target.connection.type === "ssh-config"
      ? [target.connection.type, target.connection.host]
      : [
          target.connection.type,
          target.connection.host,
          target.connection.user,
          target.connection.port,
          target.connection.identityFile ?? null,
        ]
  return JSON.stringify([
    connection,
    [...target.workspaceRoots].sort(),
    target.command ? [target.command.program, target.command.args] : null,
    target.skillStagingRoot ?? null,
    clientVersion,
  ])
}

export * as RexdConnectionPool from "./connection-pool"
