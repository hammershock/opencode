export * as SyncConflict from "./conflict"

import { SyncEvent } from "./event"
import { SyncRuntime } from "./runtime"

/** Stable merge independent of download order. Tombstoned aggregates are never returned. */
export async function mergeEvents(
  events: readonly { readonly deviceID: SyncEvent.DeviceID; readonly event: SyncEvent.Envelope }[],
  input: { readonly owners: Readonly<Record<string, string>>; readonly deleted?: ReadonlySet<string> },
) {
  const groups = new Map<string, typeof events>()
  for (const item of events) {
    if (input.deleted?.has(item.event.aggregateID)) continue
    const key = `${item.event.aggregateID}\0${item.event.seq}`
    groups.set(key, [...(groups.get(key) ?? []), item])
  }
  const main: (typeof events)[number][] = []
  const siblings: { readonly sessionID: string; readonly source: (typeof events)[number] }[] = []
  for (const values of groups.values()) {
    const unique = [...new Map(values.map((item) => [fingerprint(item.event), item])).values()]
    unique.sort((left, right) => compare(left.deviceID, right.deviceID, input.owners[left.event.aggregateID]))
    const winner = unique[0]
    if (winner) main.push(winner)
    for (const loser of unique.slice(1))
      siblings.push({
        sessionID: await siblingID(loser.event.aggregateID, loser.deviceID, loser.event.seq),
        source: loser,
      })
  }
  main.sort(order)
  siblings.sort((left, right) => left.sessionID.localeCompare(right.sessionID) || order(left.source, right.source))
  return { main, siblings }
}

export function mergeMetadata(values: readonly { readonly deviceID: string; readonly value: SyncRuntime.Metadata }[]) {
  const result = new Map<string, SyncRuntime.Metadata>()
  const source = new Map<string, string>()
  for (const item of values) {
    const current = result.get(item.value.sessionID)
    const currentDevice = source.get(item.value.sessionID)
    if (
      !current ||
      item.value.revision > current.revision ||
      (item.value.revision === current.revision && item.deviceID.localeCompare(currentDevice ?? "") < 0)
    ) {
      result.set(item.value.sessionID, item.value)
      source.set(item.value.sessionID, item.deviceID)
    }
  }
  return [...result.values()].sort((a, b) => a.sessionID.localeCompare(b.sessionID))
}

function compare(left: string, right: string, owner?: string) {
  if (left === owner && right !== owner) return -1
  if (right === owner && left !== owner) return 1
  return left.localeCompare(right)
}

function order(left: { deviceID: string; event: SyncEvent.Envelope }, right: typeof left) {
  return (
    left.event.aggregateID.localeCompare(right.event.aggregateID) ||
    left.event.seq - right.event.seq ||
    left.deviceID.localeCompare(right.deviceID)
  )
}

function fingerprint(event: SyncEvent.Envelope) {
  return JSON.stringify(canonical(event))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  return value
}

async function siblingID(sessionID: string, deviceID: string, seq: number) {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`opencode-sync-sibling\0${sessionID}\0${deviceID}\0${seq}`),
  )
  return `${sessionID}-conflict-${Buffer.from(bytes).toString("hex").slice(0, 16)}`
}
