import { describe, expect, test } from "bun:test"
import { SyncScheduler } from "@opencode-ai/core/sync/scheduler"

describe("SyncScheduler", () => {
  test("coalesces triggers and applies bounded retry backoff", async () => {
    let calls = 0
    let resolve!: () => void
    const pending = new Promise<void>((done) => (resolve = done))
    const timers: { callback: () => void; delay: number }[] = []
    const scheduler = SyncScheduler.make({
      run: async () => {
        calls++
        await pending
      },
      intervalMs: 30_000,
      random: () => 0.5,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay })
        return 1 as any
      },
      clearTimer: () => undefined,
    })
    scheduler.start()
    expect(timers.shift()?.delay).toBe(0)
    const first = scheduler.trigger()
    const second = scheduler.trigger()
    expect(first).toBe(second)
    expect(calls).toBe(1)
    resolve()
    await first
    expect(timers.at(-1)?.delay).toBe(30_000)
  })

  test("backs off failed work and stop cancels the scheduled retry", async () => {
    const timers: { callback: () => void; delay: number }[] = []
    const cleared: unknown[] = []
    const scheduler = SyncScheduler.make({
      run: async () => {
        throw new Error("offline")
      },
      random: () => 0.5,
      setTimer: (callback, delay) => {
        timers.push({ callback, delay })
        return timers.length as any
      },
      clearTimer: (timer) => void cleared.push(timer),
    })
    scheduler.start()
    await expect(scheduler.trigger()).rejects.toThrow("offline")
    expect(scheduler.status()).toMatchObject({ failures: 1, nextDelay: 1_000 })
    expect(timers.at(-1)?.delay).toBe(1_000)
    await scheduler.stop()
    expect(cleared.length).toBeGreaterThan(0)
    expect(scheduler.status().enabled).toBe(false)
  })

  test("stop aborts and waits for the active flight", async () => {
    let completed = false
    let started!: () => void
    const active = new Promise<void>((resolve) => (started = resolve))
    const scheduler = SyncScheduler.make({
      run: async (signal) => {
        started()
        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
        await Promise.resolve()
        completed = true
      },
    })

    scheduler.start()
    await active
    await scheduler.stop()

    expect(completed).toBe(true)
    expect(scheduler.status()).toMatchObject({ enabled: false, running: false })
  })
})
