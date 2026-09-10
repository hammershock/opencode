import {
  CommandRegistry,
  createHostResolver,
  evaluateCommandRestrictions,
  type CommandProvenance,
  type CommandRestrictions,
  type InvocationContext,
  type ResolutionDiagnostic,
  type UpstreamCandidate,
} from "@opencode-ai/command-kit"

export const COMMAND_RESTRICTIONS_KEY = "command_toolkit.restrictions"
const coreCommandMarker = {}

export function isCoreCommandMetadata(value: unknown): value is {
  commandKitIdentity: string
  commandKitProvenance: CommandProvenance
  commandKitPath: readonly string[]
} {
  if (!value || typeof value !== "object") return false
  return (value as { commandKitMarker?: unknown }).commandKitMarker === coreCommandMarker
}

export type TuiUpstreamCommand = UpstreamCandidate & {
  title: string
  description?: string
  category?: string
  hidden?: boolean
  aliases?: readonly (readonly string[])[]
  dispatch:
    | { type: "client"; run: (rawArguments: string) => Promise<unknown> | unknown }
    | { type: "session"; command: string }
}

export type TuiSlashCommand = {
  identity: string
  display: string
  description?: string
  aliases?: string[]
  provenance: CommandProvenance
  shadowed: readonly ResolutionDiagnostic[]
  insertText?: string
  onSelect?: () => void
}

export type TuiCommandWinner = {
  identity: string
  path: readonly string[]
  title: string
  description?: string
  category?: string
  hidden: boolean
  enabled: boolean
  provenance: CommandProvenance
  shadowed: readonly ResolutionDiagnostic[]
  dispatch: "client" | "session"
  run: (source?: InvocationContext["source"]) => Promise<TuiCommandDispatch>
}

type TuiCommandWinnerSource = { commands: () => readonly TuiCommandWinner[] }
const activeHosts = new WeakMap<object, TuiCommandWinnerSource[]>()

export function activateCommandHost(keymap: object, host: TuiCommandWinnerSource) {
  const stack = activeHosts.get(keymap) ?? []
  stack.push(host)
  activeHosts.set(keymap, stack)
  return () => {
    const index = stack.lastIndexOf(host)
    if (index !== -1) stack.splice(index, 1)
    if (stack.length === 0) activeHosts.delete(keymap)
  }
}

export function getActiveCommandHost(keymap: object) {
  return activeHosts.get(keymap)?.at(-1)
}

export type TuiCommandDispatch =
  | {
      status: "handled"
      identity: string
      provenance: CommandProvenance
      diagnostics: readonly ResolutionDiagnostic[]
    }
  | {
      status: "session"
      identity: string
      provenance: CommandProvenance
      command: string
      arguments: string
      diagnostics: readonly ResolutionDiagnostic[]
    }
  | {
      status: "invalid"
      message: string
      diagnostics: readonly ResolutionDiagnostic[]
    }
  | { status: "passthrough"; input: string; diagnostics: readonly ResolutionDiagnostic[] }

export function normalizeCommandRestrictions(value: unknown): CommandRestrictions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const input = value as Record<string, unknown>
  const strings = (key: string) => {
    const item = input[key]
    if (!Array.isArray(item)) return undefined
    return item.filter((entry): entry is string => typeof entry === "string")
  }
  return {
    disabled: strings("disabled"),
    hidden: strings("hidden"),
    confirm: strings("confirm"),
    deniedCapabilities: strings("deniedCapabilities"),
  }
}

export function provenanceLabel(provenance: CommandProvenance) {
  if (provenance.type === "core") return "core"
  if (provenance.type === "upstream") return "upstream"
  if (provenance.type === "user-config") return "user"
  if (provenance.type === "project-config") return "project"
  if (provenance.type === "custom-command") return "custom"
  if (provenance.type === "mcp") return "mcp"
  if (provenance.type === "skill") return "skill"
  return provenance.type === "legacy-plugin" ? "plugin" : provenance.type
}

function withProvenance(description: string | undefined, provenance: CommandProvenance, shadowed = 0) {
  const suffix = `${provenanceLabel(provenance)}${shadowed ? ` · ${shadowed} shadowed` : ""}`
  return description ? `${description} · ${suffix}` : suffix
}

function matches(source: string, path: readonly string[]) {
  if (!source.startsWith("/")) return false
  const newline = source.indexOf("\n")
  const line = source.slice(0, newline === -1 ? source.length : newline)
  const tokens = line.match(/[^\t\v\f\r ]+/g) ?? []
  if (tokens.length < path.length) return false
  return path.every((token, index) => tokens[index] === (index === 0 ? `/${token}` : token))
}

export function resolveUpstreamCandidates(
  source: string,
  commands: readonly TuiUpstreamCommand[] | TuiUpstreamCommand | undefined,
) {
  return upstreamList(commands)
    .flatMap((command, priority) => [
      { ...command, priority },
      ...(command.aliases ?? []).map((aliasPath: readonly string[]) => ({ ...command, path: aliasPath, priority })),
    ])
    .filter((command) => matches(source, command.path))
    .sort((a, b) => b.path.length - a.path.length || a.priority - b.priority)
}

function upstreamList(commands: readonly TuiUpstreamCommand[] | TuiUpstreamCommand | undefined) {
  return commands ? (Array.isArray(commands) ? commands : [commands]) : []
}

export function createCommandHost<Context extends InvocationContext>(input: {
  register: (registry: CommandRegistry<Context>) => void
  context: (source: InvocationContext["source"]) => Context
  upstream: () => readonly TuiUpstreamCommand[] | TuiUpstreamCommand | undefined
  restrictions?: () => CommandRestrictions | undefined
  invalid: (message: string) => void
  outcome: (message: string, status: "completed" | "cancelled" | "failed" | "unknown") => void
  diagnostic?: (diagnostic: ResolutionDiagnostic) => void
}) {
  const registry = new CommandRegistry<Context>()
  input.register(registry)
  const diagnosticHistory: ResolutionDiagnostic[] = []

  const resolveAgainst = (source: string, upstream: readonly TuiUpstreamCommand[] | TuiUpstreamCommand | undefined) =>
    createHostResolver(registry.routes(), () => resolveUpstreamCandidates(source, upstream))(source)
  const resolve = (source: string) => resolveAgainst(source, input.upstream())

  const report = (diagnostics: readonly ResolutionDiagnostic[]) => {
    for (const diagnostic of diagnostics) {
      diagnosticHistory.push(diagnostic)
      input.diagnostic?.(diagnostic)
    }
  }

  const invokeCore = async (
    resolution: Extract<ReturnType<typeof resolve>, { status: "core" }>["resolution"],
    invocationSource: InvocationContext["source"],
  ) => {
    const command = resolution.command
    const context = input.context(invocationSource)
    if (command.available && !command.available(context)) return false
    const decision = evaluateCommandRestrictions(command, input.restrictions?.())
    if (decision.status === "denied") {
      input.outcome(
        decision.code === "command_disabled"
          ? "Command disabled by user policy"
          : `Capability denied by user policy: ${decision.capability}`,
        "failed",
      )
      return true
    }
    if (
      decision.confirm &&
      !(await context.confirm({
        title: "Run command",
        message: `Run /${resolution.route.join(" ")}?`,
        confirmLabel: "Run",
      }))
    ) {
      input.outcome("Command cancelled", "cancelled")
      return true
    }
    const prepared = command.prepare(resolution.arguments)
    if (prepared.status === "invalid") {
      input.invalid(prepared.message)
      return true
    }
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

  const dispatch = async (
    source: string,
    invocationSource: InvocationContext["source"] = "slash",
  ): Promise<TuiCommandDispatch> => {
    const resolution = resolve(source)
    report(resolution.diagnostics)
    if (resolution.status === "passthrough") {
      if (!source.startsWith("/")) return resolution
      const message = "Slash command does not exist"
      input.invalid(message)
      return { status: "invalid", message, diagnostics: resolution.diagnostics }
    }
    if (resolution.status === "core") {
      const handled = await invokeCore(resolution.resolution, invocationSource)
      if (!handled) return { status: "passthrough", input: source, diagnostics: resolution.diagnostics }
      return {
        status: "handled",
        identity: resolution.resolution.command.id,
        provenance: resolution.resolution.command.provenance,
        diagnostics: resolution.diagnostics,
      }
    }
    const candidate = resolution.candidate as TuiUpstreamCommand
    if (candidate.dispatch.type === "session") {
      return {
        status: "session",
        identity: candidate.id,
        provenance: candidate.provenance,
        command: candidate.dispatch.command,
        arguments: resolution.arguments.value,
        diagnostics: resolution.diagnostics,
      }
    }
    await candidate.dispatch.run(resolution.arguments.value)
    return {
      status: "handled",
      identity: candidate.id,
      provenance: candidate.provenance,
      diagnostics: resolution.diagnostics,
    }
  }

  const registrations = () => {
    const restrictions = input.restrictions?.()
    return registry.list().flatMap((command) => {
      if (restrictions?.hidden?.includes(command.id)) return []
      const canonical = `/${command.path.join(" ")}`
      return [
        {
          namespace: "palette" as const,
          name: command.id,
          title: command.title,
          desc: withProvenance(command.description, command.provenance),
          category: command.category,
          slashName: command.path.join(" "),
          slashAliases: command.aliases?.map((path) => path.join(" ")),
          commandKitIdentity: command.id,
          commandKitProvenance: command.provenance,
          commandKitPath: command.path,
          commandKitMarker: coreCommandMarker,
          enabled: () => {
            const decision = evaluateCommandRestrictions(command, input.restrictions?.())
            return (
              decision.status === "allowed" && (command.available ? command.available(input.context("palette")) : true)
            )
          },
          run: () => dispatch(canonical, "palette"),
        },
      ]
    })
  }

  const commands = (): TuiCommandWinner[] => {
    const restrictions = input.restrictions?.()
    const upstream = upstreamList(input.upstream())
    const routes = [
      ...upstream.flatMap((command) => [command.path, ...(command.aliases ?? [])]),
      ...registry.routes().map((route) => route.path),
    ]
    const unique = new Map<string, readonly string[]>()
    for (const route of routes) unique.set(route.join("\u0000"), route)
    return [...unique.values()].flatMap((route): TuiCommandWinner[] => {
      const source = `/${route.join(" ")}`
      const resolution = resolveAgainst(source, upstream)
      if (resolution.status === "passthrough") return []
      if (resolution.status === "core") {
        const command = resolution.resolution.command
        const decision = evaluateCommandRestrictions(command, restrictions)
        return [
          {
            identity: command.id,
            path: route,
            title: command.title,
            description: withProvenance(command.description, command.provenance, resolution.diagnostics.length),
            category: command.category,
            hidden: restrictions?.hidden?.includes(command.id) === true,
            enabled:
              decision.status === "allowed" && (command.available ? command.available(input.context("palette")) : true),
            provenance: command.provenance,
            shadowed: resolution.diagnostics,
            dispatch: "client" as const,
            run: (invocationSource: InvocationContext["source"] = "palette") => dispatch(source, invocationSource),
          },
        ]
      }
      const command = resolution.candidate as TuiUpstreamCommand
      return [
        {
          identity: command.id,
          path: route,
          title: command.title,
          description: withProvenance(command.description, command.provenance, resolution.diagnostics.length),
          category: command.category,
          hidden: command.hidden === true,
          enabled: true,
          provenance: command.provenance,
          shadowed: resolution.diagnostics,
          dispatch: command.dispatch.type,
          run: (invocationSource: InvocationContext["source"] = "palette") => dispatch(source, invocationSource),
        },
      ]
    })
  }

  const slashes = (): TuiSlashCommand[] => {
    return commands()
      .filter((command) => !command.hidden)
      .map((command) => {
        const source = `/${command.path.join(" ")}`
        return {
          identity: command.identity,
          display: source,
          description:
            command.description ?? withProvenance(command.title, command.provenance, command.shadowed.length),
          provenance: command.provenance,
          shadowed: command.shadowed,
          ...(command.dispatch === "session"
            ? { insertText: `${source} ` }
            : { onSelect: () => void command.run("slash") }),
        }
      })
      .sort((a, b) => a.display.localeCompare(b.display))
  }

  return Object.assign(dispatch, {
    resolve,
    commands,
    registrations,
    slashes,
    diagnostics: () => [...diagnosticHistory],
  })
}
