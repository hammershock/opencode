export type CommandProvenance =
  | { type: "core"; feature: string }
  | { type: "upstream"; host: string; identity: string }
  | { type: "user-config" }
  | { type: "project-config" }
  | { type: "custom-command" }
  | { type: "mcp"; serverID: string }
  | { type: "skill"; location: string }
  | { type: "plugin" | "legacy-plugin"; pluginID: string; version?: string }

export type RawArguments = {
  source: string
  value: string
  range: TextRange
}

export type TextRange = {
  start: number
  end: number
}

export type ParseResult<Input> =
  | { status: "parsed"; input: Input }
  | { status: "invalid"; code: string; message: string; range?: TextRange }

export type CompletionInput = {
  source: string
  cursor: number
  arguments: RawArguments
}

export type CompletionItem = {
  label: string
  replacement: TextRange
  insertText?: string
  detail?: string
}

export type ConfirmationRequest = {
  title: string
  message: string
  confirmLabel?: string
  destructive?: boolean
}

export type InvocationContext = {
  source: "slash" | "palette" | "keybind"
  client: "tui" | "web" | "desktop" | "cli"
  sessionID?: string
  location?: unknown
  abortSignal: AbortSignal
  confirm: (request: ConfirmationRequest) => Promise<boolean>
}

export type CommandFailure = {
  status: "failed"
  code: string
  message: string
  retryable: boolean
}

export type CommandOutcome =
  | { status: "completed"; message?: string }
  | { status: "cancelled"; message?: string }
  | CommandFailure
  | { status: "unknown"; message: string }

export type CommandDefinition<Input, Context extends InvocationContext = InvocationContext> = {
  id: string
  path: readonly string[]
  aliases?: readonly (readonly string[])[]
  title: string
  description?: string
  category?: string
  provenance: CommandProvenance
  requires?: { session?: boolean; location?: boolean }
  /** Whether the command may execute while the current Session is read-only. Defaults to false. */
  readOnly?: boolean
  capabilities: readonly string[]
  parse: (input: RawArguments) => ParseResult<Input>
  complete?: (input: CompletionInput, context: Context) => Promise<readonly CompletionItem[]>
  available?: (context: Context) => boolean
  execute: (context: Context, input: Input) => Promise<CommandOutcome>
}

export type PreparedCommand<Context extends InvocationContext = InvocationContext> =
  | Extract<ParseResult<never>, { status: "invalid" }>
  | { status: "parsed"; execute: (context: Context) => Promise<CommandOutcome> }

export type RegisteredCommand<Context extends InvocationContext = InvocationContext> = Pick<
  CommandDefinition<unknown, Context>,
  | "id"
  | "path"
  | "aliases"
  | "title"
  | "description"
  | "category"
  | "provenance"
  | "requires"
  | "readOnly"
  | "capabilities"
  | "complete"
  | "available"
> & {
  prepare: (input: RawArguments) => PreparedCommand<Context>
}

/** Device-local restrictions may only remove access or add confirmation. */
export type CommandRestrictions = {
  disabled?: readonly string[]
  hidden?: readonly string[]
  confirm?: readonly string[]
  deniedCapabilities?: readonly string[]
}

export type CommandPolicyDecision =
  | { status: "allowed"; confirm: boolean }
  | { status: "denied"; code: "command_disabled" | "capability_denied"; capability?: string }

export function evaluateCommandRestrictions(
  command: Pick<RegisteredCommand, "id" | "capabilities">,
  restrictions: CommandRestrictions | undefined,
): CommandPolicyDecision {
  if (restrictions?.disabled?.includes(command.id)) return { status: "denied", code: "command_disabled" }
  const capability = command.capabilities.find((item) => restrictions?.deniedCapabilities?.includes(item))
  if (capability) return { status: "denied", code: "capability_denied", capability }
  return { status: "allowed", confirm: restrictions?.confirm?.includes(command.id) === true }
}

export function defineCommand<Input, Context extends InvocationContext = InvocationContext>(
  definition: CommandDefinition<Input, Context>,
) {
  return definition
}
