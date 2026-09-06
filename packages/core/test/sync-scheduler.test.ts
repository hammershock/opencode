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
})
