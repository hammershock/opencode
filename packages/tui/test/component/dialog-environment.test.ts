import { describe, expect, test } from "bun:test"
import {
  clearEnvironmentValues,
  createEnvironmentRevealAuthorization,
  displayEnvironmentValue,
  environmentEntry,
  environmentInspectionFrame,
  environmentVariableOption,
} from "../../src/component/dialog-environment"

describe("environment variable metadata", () => {
  test("shows effective and overridden origins without a value", () => {
    const variable = {
      name: "API_TOKEN",
      origin: "project",
      source: "/workspace/.env",
      overrides: ["base", "user"],
      value: "secret-value",
    }
    const option = environmentVariableOption(variable)

    expect(option).toEqual({
      title: "API_TOKEN",
      description: "/workspace/.env",
      footer: "project · overrides base, user",
      value: "API_TOKEN",
    })
    expect(JSON.stringify(option)).not.toContain("secret-value")
  })

  test("keeps a source without overrides concise", () => {
    expect(environmentVariableOption({ name: "PATH", origin: "base", overrides: [] })).toEqual({
      title: "PATH",
      description: undefined,
      footer: "base",
      value: "PATH",
    })
  })

  test("adds revealed values without moving metadata into the title", () => {
    expect(
      environmentVariableOption(
        { name: "API_TOKEN", origin: "project", source: "/workspace/.env", overrides: ["base"] },
        { API_TOKEN: "synthetic-value" },
      ),
    ).toEqual({
      title: "API_TOKEN",
      description: "/workspace/.env",
      footer: "project · overrides base",
      value: "API_TOKEN",
      revealed: "synthetic-value",
    })
  })

  test("authorizes once per process state and retries after a decline", async () => {
    const authorize = createEnvironmentRevealAuthorization()
    let confirmations = 0
    expect(
      await authorize(async () => {
        confirmations++
        return false
      }),
    ).toBeFalse()
    expect(
      await authorize(async () => {
        confirmations++
        return true
      }),
    ).toBeTrue()
    expect(
      await authorize(async () => {
        confirmations++
        return false
      }),
    ).toBeTrue()
    expect(confirmations).toBe(2)
    expect(await createEnvironmentRevealAuthorization()(async () => false)).toBeFalse()
  })

  test("clears revealed values and keeps control characters on one row", () => {
    const revealed: { generation: number; values: Record<string, string> } = {
      generation: 1,
      values: { TOKEN: "synthetic-value", EMPTY: "" },
    }
    expect(displayEnvironmentValue("first\r\nsecond\tcolumn")).toBe("first\\r\\nsecond\\tcolumn")
    clearEnvironmentValues(revealed)
    expect(revealed.values).toEqual({})
  })

  test("copies the selected entry without changing its raw value", () => {
    expect(environmentEntry("EMPTY", "")).toBe("EMPTY=")
    expect(environmentEntry("MULTILINE", "first\nsecond\tcolumn")).toBe("MULTILINE=first\nsecond\tcolumn")
  })

  test("cycles only the selected row while retaining value styling", () => {
    const frames = Array.from({ length: "TOKEN=synthetic-value   ".length }, (_, offset) =>
      environmentInspectionFrame("TOKEN", "synthetic-value", 10, offset),
    )

    expect(frames.every((frame) => Bun.stringWidth(frame.map((segment) => segment.text).join("")) <= 10)).toBeTrue()
    expect(
      frames
        .flat()
        .filter((segment) => segment.revealed)
        .map((segment) => segment.text)
        .join(" "),
    ).toContain("synthetic")
    expect(
      frames.some((frame) => frame.some((segment) => segment.revealed) && frame.some((segment) => !segment.revealed)),
    ).toBeTrue()
  })
})
