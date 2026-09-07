import { describe, expect, test } from "bun:test"
import { environmentVariableOption } from "../../src/component/dialog-environment"

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
})
