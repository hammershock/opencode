type VariantModel = {
  variants?: Record<string, unknown>
}

/**
 * Provider variants are an ordered record: the producer inserts entries in the
 * provider/model declaration's semantic order. Keep that contract in one place
 * so consumers never infer strength from provider-specific variant names.
 */
export function declaredVariantOrder(model: VariantModel | undefined) {
  return Object.keys(model?.variants ?? {})
}

export function effectiveVariant(input: {
  selected: string | undefined
  configured: string | undefined
  variants: readonly string[]
}) {
  if (input.selected && input.selected !== "default" && input.variants.includes(input.selected)) return input.selected
  if (input.configured && input.variants.includes(input.configured)) return input.configured
}

export function moveVariant(input: {
  current: string | undefined
  variants: readonly string[]
  direction: -1 | 1
}) {
  if (input.variants.length === 0) return { available: false as const, value: undefined }
  if (!input.current || !input.variants.includes(input.current)) {
    return { available: true as const, value: input.direction === 1 ? input.variants[0] : undefined }
  }
  const index = input.variants.indexOf(input.current)
  return {
    available: true as const,
    value: input.variants[Math.max(0, Math.min(input.variants.length - 1, index + input.direction))],
  }
}

export function canAdjustVariant(input: {
  disabled: boolean
  mode: "normal" | "shell"
  autocompleteVisible: boolean
  dialogOpen: boolean
}) {
  return (
    !input.disabled &&
    input.mode === "normal" &&
    !input.autocompleteVisible &&
    !input.dialogOpen
  )
}
