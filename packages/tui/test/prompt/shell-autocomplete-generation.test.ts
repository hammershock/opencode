import { describe, expect, test } from "bun:test"
import {
  createShellCompletionGeneration,
  invalidateShellCompletion,
  invalidateShellCompletionContext,
  settleShellCompletionKeyEvent,
  shellCompletionDegradedMessage,
} from "../../src/component/prompt/autocomplete"
import { createEffect, createRoot, createSignal } from "solid-js"

describe("Shell autocomplete generation", () => {
  test("rejects a delayed result after input or cursor mutation", () => {
    const generation = createShellCompletionGeneration()
    const request = generation.begin()

    invalidateShellCompletion(generation, false, () => undefined)

    expect(generation.accepts(request)).toBe(false)
  })

  test("invalidates an already visible list before a stale candidate can apply", () => {
    const generation = createShellCompletionGeneration()
    const request = generation.begin()
    expect(generation.accepts(request)).toBe(true)
    let hidden = false

    invalidateShellCompletion(generation, "shell", () => {
      hidden = true
    })

    expect(hidden).toBe(true)
    expect(generation.accepts(request)).toBe(false)
  })

  test("starts the request after the Tab editor notification settles", async () => {
    const generation = createShellCompletionGeneration()
    const request = settleShellCompletionKeyEvent().then(() => generation.begin())

    invalidateShellCompletion(generation, false, () => undefined)

    expect(generation.accepts(await request)).toBe(true)
  })
})

test("shell completion degradation is concise and identifies the fallback", () => {
  expect(shellCompletionDegradedMessage("native_timeout")).toBe("Native completion timed out; showing basic matches")
  expect(shellCompletionDegradedMessage("native_failed")).toBe("Native completion failed; showing basic matches")
  expect(shellCompletionDegradedMessage("native_unavailable")).toBe(
    "Native completion unavailable; showing basic matches",
  )
})

test("opening a multi-candidate shell popup does not invalidate its own generation", async () => {
  await new Promise<void>((resolve, reject) =>
    createRoot((dispose) => {
      const generation = createShellCompletionGeneration()
      const [context, setContext] = createSignal(0)
      const [visible, setVisible] = createSignal<false | "shell">(false)
      let hidden = 0

      createEffect(() => {
        context()
        invalidateShellCompletionContext(generation, visible, () => {
          hidden++
          setVisible(false)
        })
      })

      queueMicrotask(() => {
        try {
          const request = generation.begin()
          setVisible("shell")
          queueMicrotask(() => {
            try {
              expect(generation.accepts(request)).toBe(true)
              expect(visible()).toBe("shell")
              expect(hidden).toBe(0)

              setContext(1)
              queueMicrotask(() => {
                try {
                  expect(generation.accepts(request)).toBe(false)
                  expect(visible()).toBe(false)
                  expect(hidden).toBe(1)
                  dispose()
                  resolve()
                } catch (error) {
                  dispose()
                  reject(error)
                }
              })
            } catch (error) {
              dispose()
              reject(error)
            }
          })
        } catch (error) {
          dispose()
          reject(error)
        }
      })
    }),
  )
})
