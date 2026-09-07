import { CommandRegistry, createHostResolver, type InvocationContext } from "@opencode-ai/command-kit"

export function createCommandHost<Context extends InvocationContext>(input: {
  register: (registry: CommandRegistry<Context>) => void
  context: (source: InvocationContext["source"]) => Context
  upstream: (
    source: string,
  ) =>
    | { id: string; path: readonly string[]; provenance: { type: "upstream"; host: string; identity: string } }
    | undefined
  invalid: (message: string) => void
  outcome: (message: string, status: "completed" | "cancelled" | "failed" | "unknown") => void
}) {
  const registry = new CommandRegistry<Context>()
  input.register(registry)
  const resolve = createHostResolver(registry.routes(), input.upstream)
  const invoke = async (source: string, invocationSource: InvocationContext["source"] = "slash") => {
    const resolution = resolve(source)
    if (resolution.status !== "core") return false
    const prepared = resolution.resolution.command.prepare(resolution.resolution.arguments)
    if (prepared.status === "invalid") {
      input.invalid(prepared.message)
      return true
    }
    const context = input.context(invocationSource)
    if (resolution.resolution.command.available && !resolution.resolution.command.available(context)) return false
    let result
    try {
      result = await prepared.execute(context)
    } catch (cause) {
      input.outcome(cause instanceof Error ? cause.message : "Command failed", "failed")
      return true
    }
    if (result.message) input.outcome(result.message, result.status)
    return true
  }
  return Object.assign(invoke, {
    commands: () =>
      registry.list().map((command) => ({
        namespace: "palette" as const,
        name: command.id,
        title: command.title,
        desc: command.description,
        category: command.category,
        slashName: command.path.join(" "),
        slashAliases: command.aliases?.map((path) => path.join(" ")),
        enabled: command.available ? command.available(input.context("palette")) : true,
        run: () => invoke(`/${command.path.join(" ")}`, "palette"),
      })),
  })
}
