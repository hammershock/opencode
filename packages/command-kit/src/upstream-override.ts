export type UpstreamCommandContract = {
  identity: string
  host: string
  path: readonly string[]
  aliases: readonly (readonly string[])[]
  title: string
  category: string
  availability: string
  inputBoundary: string
}

export type UpstreamContractFingerprint = `${string}:${string}:${string}`

export type VerifiedUpstreamCommand<Contract extends UpstreamCommandContract = UpstreamCommandContract> = {
  contract: Contract
  fingerprint: UpstreamContractFingerprint
}

export function defineUpstreamCommand<const Contract extends UpstreamCommandContract>(
  contract: Contract,
  fingerprint: UpstreamContractFingerprint,
): VerifiedUpstreamCommand<Contract> {
  return { contract, fingerprint }
}

type Equal<Left, Right> =
  (<Value>() => Value extends Left ? 1 : 2) extends <Value>() => Value extends Right ? 1 : 2
    ? (<Value>() => Value extends Right ? 1 : 2) extends <Value>() => Value extends Left ? 1 : 2
      ? true
      : false
    : false

type RequireExact<Expected, Current> = Equal<Expected, Current> extends true ? unknown : never

/**
 * This assertion deliberately has no runtime discovery behavior. Both inputs remain
 * literal types, so a source contract change makes typecheck fail until the pinned
 * baseline is explicitly reviewed and updated.
 */
export function verifyUpstreamCommand<
  const Expected extends VerifiedUpstreamCommand,
  const Current extends VerifiedUpstreamCommand,
>(expected: Expected, current: Current & RequireExact<Expected, Current>) {
  return current
}

export type OverrideWarning = {
  type: "upstream-override-fallback"
  overrideID: string
  upstreamIdentity: string
  phase: "install" | "apply"
  reason: string
}

export type OverrideDiagnostic =
  | { status: "disabled" }
  | { status: "active" }
  | { status: "fallback"; warning: OverrideWarning }

export type OverrideApplication<Value> = { status: "handled"; value: Value } | { status: "unavailable"; reason: string }

export type UpstreamOverride<Input, Value> = {
  id: string
  target: VerifiedUpstreamCommand
  experimentalSetting: string
  decorate: (next: (input: Input) => Promise<Value>) => (input: Input) => Promise<OverrideApplication<Value>>
}

export type InstalledOverride<Input, Value> = {
  execute: (input: Input) => Promise<Value>
  diagnostic: () => OverrideDiagnostic
}

export function installUpstreamOverride<Input, Value>(input: {
  definition: UpstreamOverride<Input, Value>
  enabled: boolean
  upstream: (input: Input) => Promise<Value>
  warning: (warning: OverrideWarning) => void
}): InstalledOverride<Input, Value> {
  if (!input.enabled) return { execute: input.upstream, diagnostic: () => ({ status: "disabled" }) }

  const state: { value: OverrideDiagnostic } = { value: { status: "active" } }
  const fallback = (phase: OverrideWarning["phase"], reason: unknown) => {
    const warning: OverrideWarning = {
      type: "upstream-override-fallback",
      overrideID: input.definition.id,
      upstreamIdentity: input.definition.target.contract.identity,
      phase,
      reason: safeReason(reason),
    }
    state.value = { status: "fallback", warning }
    input.warning(warning)
  }

  try {
    const execute = input.definition.decorate(input.upstream)
    return {
      diagnostic: () => state.value,
      execute: async (value) => {
        if (state.value.status === "fallback") return input.upstream(value)
        try {
          const result = await execute(value)
          if (result.status === "handled") return result.value
          fallback("apply", result.reason)
        } catch (error) {
          fallback("apply", error)
        }
        return input.upstream(value)
      },
    }
  } catch (error) {
    fallback("install", error)
    return { execute: input.upstream, diagnostic: () => state.value }
  }
}

function safeReason(reason: unknown) {
  if (reason instanceof Error) return reason.name
  if (typeof reason === "string") return reason
  return "Unknown override failure"
}
