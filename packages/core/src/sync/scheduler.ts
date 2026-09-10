export * as SyncScheduler from "./scheduler"

export function make(input: {
  readonly run: (signal: AbortSignal) => Promise<void>
  readonly intervalMs?: number
  readonly maximumBackoffMs?: number
  readonly random?: () => number
  readonly setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}) {
  const interval = input.intervalMs ?? 30_000
  const maximum = input.maximumBackoffMs ?? 5 * 60_000
  const random = input.random ?? Math.random
  const setTimer = input.setTimer ?? setTimeout
  const clearTimer = input.clearTimer ?? clearTimeout
  let enabled = false
  let failures = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  let flight: Promise<void> | undefined
  let controller: AbortController | undefined

  const schedule = (delay: number) => {
    if (!enabled) return
    if (timer) clearTimer(timer)
    timer = setTimer(() => {
      timer = undefined
      void trigger().catch(() => undefined)
    }, delay)
  }
  const nextDelay = () => {
    if (!failures) return interval
    const bounded = Math.min(maximum, 1_000 * 2 ** Math.min(failures - 1, 16))
    return Math.floor(bounded * (0.75 + random() * 0.5))
  }
  const trigger = () => {
    if (!enabled) return Promise.resolve()
    if (flight) return flight
    const current = new AbortController()
    controller = current
    flight = input
      .run(current.signal)
      .then(() => void (failures = 0))
      .catch((cause) => {
        failures++
        throw cause
      })
      .finally(() => {
        if (controller === current) controller = undefined
        flight = undefined
        schedule(nextDelay())
      })
    return flight
  }
  return {
    start: () => {
      if (enabled) return
      enabled = true
      schedule(0)
    },
    stop: async () => {
      enabled = false
      if (timer) clearTimer(timer)
      timer = undefined
      controller?.abort(new Error("Sync scheduler stopped"))
      await flight?.catch(() => undefined)
    },
    trigger,
    networkRestored: trigger,
    status: () => ({ enabled, running: Boolean(flight), failures, nextDelay: nextDelay() }),
  }
}
