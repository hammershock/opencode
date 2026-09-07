import { describe, expect, test } from "bun:test"
import { canAdjustVariant, declaredVariantOrder, effectiveVariant, moveVariant } from "../src/model-variant"

describe("declared variant order", () => {
  test("preserves the provider/model declaration order", () => {
    expect(declaredVariantOrder({ variants: { focused: {}, balanced: {}, fast: {} } })).toEqual([
      "focused",
      "balanced",
      "fast",
    ])
  })

  test("does not invent variants for a model without declarations", () => {
    expect(declaredVariantOrder(undefined)).toEqual([])
    expect(declaredVariantOrder({})).toEqual([])
  })
})

describe("effective variant", () => {
  const variants = ["small", "normal", "large"]

  test("prefers an explicit valid device selection", () => {
    expect(effectiveVariant({ selected: "large", configured: "normal", variants })).toBe("large")
  })

  test("resolves default and unavailable selections through the configured variant", () => {
    expect(effectiveVariant({ selected: "default", configured: "normal", variants })).toBe("normal")
    expect(effectiveVariant({ selected: "removed", configured: "normal", variants })).toBe("normal")
  })

  test("ignores a configured value not declared by the model", () => {
    expect(effectiveVariant({ selected: "default", configured: "provider-missing", variants })).toBeUndefined()
  })
})

describe("directional movement", () => {
  const variants = ["small", "normal", "large"]

  test("moves relative to a resolved default baseline", () => {
    expect(moveVariant({ current: "normal", variants, direction: -1 })).toEqual({ available: true, value: "small" })
    expect(moveVariant({ current: "normal", variants, direction: 1 })).toEqual({ available: true, value: "large" })
  })

  test("does not wrap at either endpoint", () => {
    expect(moveVariant({ current: "small", variants, direction: -1 })).toEqual({ available: true, value: "small" })
    expect(moveVariant({ current: "large", variants, direction: 1 })).toEqual({ available: true, value: "large" })
  })

  test("treats the provider default as below the first declaration when no baseline resolves", () => {
    expect(moveVariant({ current: undefined, variants, direction: -1 })).toEqual({ available: true, value: undefined })
    expect(moveVariant({ current: undefined, variants, direction: 1 })).toEqual({ available: true, value: "small" })
  })

  test("reports a model without variants", () => {
    expect(moveVariant({ current: undefined, variants: [], direction: 1 })).toEqual({
      available: false,
      value: undefined,
    })
  })
})

describe("variant shortcut focus priority", () => {
  const active = {
    disabled: false,
    mode: "normal" as const,
    autocompleteVisible: false,
    dialogOpen: false,
  }

  test("is active for the normal prompt target unless disabled", () => {
    expect(canAdjustVariant(active)).toBe(true)
    expect(canAdjustVariant({ ...active, disabled: true })).toBe(false)
  })

  test("yields to Shell, autocomplete, and dialog consumers", () => {
    expect(canAdjustVariant({ ...active, mode: "shell" })).toBe(false)
    expect(canAdjustVariant({ ...active, autocompleteVisible: true })).toBe(false)
    expect(canAdjustVariant({ ...active, dialogOpen: true })).toBe(false)
  })
})
