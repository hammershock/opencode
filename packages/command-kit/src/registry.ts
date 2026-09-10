import type { CommandDefinition, InvocationContext, RegisteredCommand } from "./types"

export type CommandRoute<Context extends InvocationContext = InvocationContext> = {
  path: readonly string[]
  type: "canonical" | "alias"
  command: RegisteredCommand<Context>
}

export type RegistryConflict =
  | { type: "duplicate-id"; id: string }
  | {
      type: "duplicate-route"
      path: readonly string[]
      existingID: string
      incomingID: string
      existingType: "canonical" | "alias"
      incomingType: "canonical" | "alias"
    }

export class CommandRegistryError extends Error {
  constructor(readonly conflict: RegistryConflict) {
    super(formatConflict(conflict))
    this.name = "CommandRegistryError"
  }
}

export class CommandRegistry<Context extends InvocationContext = InvocationContext> {
  readonly #commands = new Map<string, RegisteredCommand<Context>>()
  readonly #routes = new Map<string, CommandRoute<Context>>()

  register<Input>(definition: CommandDefinition<Input, Context>) {
    validateDefinition(definition)
    if (this.#commands.has(definition.id)) {
      throw new CommandRegistryError({ type: "duplicate-id", id: definition.id })
    }

    const complete = definition.complete
    const available = definition.available
    const command: RegisteredCommand<Context> = {
      id: definition.id,
      path: definition.path,
      aliases: definition.aliases,
      title: definition.title,
      description: definition.description,
      category: definition.category,
      provenance: definition.provenance,
      requires: definition.requires,
      readOnly: definition.readOnly,
      capabilities: definition.capabilities,
      complete: complete ? (input, context) => complete(input, context) : undefined,
      available: available ? (context) => available(context) : undefined,
      prepare: (raw) => {
        const parsed = definition.parse(raw)
        if (parsed.status === "invalid") return parsed
        return { status: "parsed", execute: (context) => definition.execute(context, parsed.input) }
      },
    }
    const routes: CommandRoute<Context>[] = [
      { path: definition.path, type: "canonical", command },
      ...(definition.aliases ?? []).map((path): CommandRoute<Context> => ({ path, type: "alias", command })),
    ]
    const seen = new Map<string, CommandRoute<Context>>()

    routes.forEach((route) => {
      const key = routeKey(route.path)
      const existing = this.#routes.get(key) ?? seen.get(key)
      if (!existing) {
        seen.set(key, route)
        return
      }
      throw new CommandRegistryError({
        type: "duplicate-route",
        path: route.path,
        existingID: existing.command.id,
        incomingID: definition.id,
        existingType: existing.type,
        incomingType: route.type,
      })
    })

    this.#commands.set(definition.id, command)
    routes.forEach((route) => this.#routes.set(routeKey(route.path), route))
    return command
  }

  list() {
    return [...this.#commands.values()]
  }

  routes() {
    return [...this.#routes.values()]
  }
}

function validateDefinition<Input, Context extends InvocationContext>(definition: CommandDefinition<Input, Context>) {
  if (!/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/.test(definition.id)) {
    throw new TypeError(`Invalid command id: ${definition.id}`)
  }
  if (definition.path.length === 0) throw new TypeError(`Command ${definition.id} must have a non-empty path`)
  ;[definition.path, ...(definition.aliases ?? [])].forEach((path) => {
    if (path.length === 0) throw new TypeError(`Command ${definition.id} has an empty route`)
    path.forEach((token) => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(token)) {
        throw new TypeError(`Invalid command token for ${definition.id}: ${token}`)
      }
    })
  })
}

function routeKey(path: readonly string[]) {
  return path.join("\u0000")
}

function formatConflict(conflict: RegistryConflict) {
  if (conflict.type === "duplicate-id") return `Duplicate command id: ${conflict.id}`
  return `Command route /${conflict.path.join(" ")} conflicts between ${conflict.existingID} and ${conflict.incomingID}`
}
