import { CommandRegistry, createHostResolver, type InvocationContext } from "@opencode-ai/command-kit"

export function createCommandHost<Context extends InvocationContext>(input: {
  register: (registry: CommandRegistry<Context>) => void
  context: () => Context
  upstream: (source: string) => { id: string; path: readonly string[]; provenance: { type: "upstream"; host: string; identity: string } } | undefined
  invalid: (message: string) => void
  outcome: (message: string, status: "completed" | "cancelled" | "failed" | "unknown") => void
}) {
  const registry = new CommandRegistry<Context>()
  input.register(registry)
  const resolve = createHostResolver(registry.routes(), input.upstream)
  return async (source: string) => {
    const resolution = resolve(source)
    if (resolution.status !== "core") return false
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    if (prepared.status === "invalid") {
      input.invalid(prepared.message)
      return true
    }
    const context = input.context()
    if (resolution.resolution.command.available && !resolution.resolution.command.available(context)) return false
    const result = await prepared.execute(context)
    if (result.message) input.outcome(result.message, result.status)
    return true
  }
}
