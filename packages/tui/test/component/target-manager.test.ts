import { describe, expect, test } from "bun:test"
import { probeTargetHealth, targetHealthLabel, targetProbeGenerations } from "../../src/component/target-manager"

describe("target health presentation", () => {
  test("reserves the healthy symbol for ready targets", () => {
    expect(targetHealthLabel("checking")).toBe("◐ checking")
    expect(targetHealthLabel("ready")).toBe("● ready")
    expect(targetHealthLabel("unavailable")).toBe("! unavailable")
    expect(targetHealthLabel("invalid")).toBe("! invalid")
  })

  test("publishes a ready target without waiting for an offline peer", async () => {
    let releaseOffline!: () => void
    const offline = new Promise<void>((resolve) => {
      releaseOffline = resolve
    })
    const published: string[] = []

    const probing = probeTargetHealth(
      ["offline", "ready"],
      async (targetID) => {
        if (targetID === "offline") {
          await offline
          return { status: "unavailable" as const, stage: "ssh", message: "timed out" }
        }
        return { status: "ready" as const }
      },
      (targetID) => published.push(targetID),
    )

    await Bun.sleep(0)
    expect(published).toEqual(["ready"])
    releaseOffline()
    await probing
    expect(published).toEqual(["ready", "offline"])
  })

  test("a newer partial refresh does not discard unrelated target results", () => {
    const generations = targetProbeGenerations()
    const initial = generations.begin(["ready", "offline"])
    const retry = generations.begin(["offline"])

    expect(generations.accept("ready", initial)).toBe(true)
    expect(generations.accept("offline", initial)).toBe(false)
    expect(generations.accept("offline", retry)).toBe(true)
  })

  test("a synchronous SDK failure still publishes completion", async () => {
    const published: Array<[string, unknown]> = []
    await probeTargetHealth(
      ["broken"],
      () => {
        throw new TypeError("SDK method lost its receiver")
      },
      (targetID, result) => published.push([targetID, result]),
    )
    expect(published).toEqual([["broken", undefined]])
  })
})
