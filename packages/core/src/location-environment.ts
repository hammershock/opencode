export * as LocationEnvironment from "./location-environment"

import path from "path"
import { Context, Effect, Layer, Schema, Semaphore } from "effect"
import { Config } from "./config"
import { makeLocationNode } from "./effect/app-node"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"

export type Origin = "base" | "user" | "project" | "explicit"

export type SourceFile = {
  readonly path: string
  readonly origin: Exclude<Origin, "base" | "explicit">
  readonly content?: string
}

export type Capture = {
  readonly base: Readonly<Record<string, string>>
  readonly files: readonly SourceFile[]
}

export class SourceError extends Schema.TaggedErrorClass<SourceError>()("LocationEnvironment.SourceError", {
  source: Schema.String,
  code: Schema.String,
}) {}

export interface SourceInterface {
  /** The provider performs every read on the Location target and returns no shell startup effects. */
  readonly capture: (input: {
    readonly workspaceRoot: string
    readonly directory: string
  }) => Effect.Effect<Capture, SourceError>
  readonly ensureTemplate: (directory: string, content: string) => Effect.Effect<"created" | "existing", SourceError>
}

export class Source extends Context.Service<Source, SourceInterface>()("@opencode/LocationEnvironmentSource") {}

export type Diagnostic = {
  readonly source: string
  readonly line: number
  readonly column: number
  readonly code: string
  readonly message: string
}

export class LoadError extends Schema.TaggedErrorClass<LoadError>()("LocationEnvironment.LoadError", {
  diagnostics: Schema.Array(
    Schema.Struct({
      source: Schema.String,
      line: Schema.Number,
      column: Schema.Number,
      code: Schema.String,
      message: Schema.String,
    }),
  ),
}) {}

export type Variable = {
  readonly name: string
  readonly origin: Origin
  readonly source?: string
  readonly overrides: readonly Origin[]
}

export type Snapshot = {
  readonly enabled: boolean
  readonly generation: number
  readonly values: Readonly<Record<string, string>>
  readonly variables: readonly Variable[]
  readonly sources: readonly { path: string; origin: SourceFile["origin"]; present: boolean }[]
}

export interface Reveal {
  readonly values: () => Readonly<Record<string, string>>
  readonly close: () => void
}

export interface Interface {
  readonly snapshot: () => Effect.Effect<Snapshot>
  readonly reload: () => Effect.Effect<Snapshot, LoadError | SourceError>
  readonly environment: (explicit?: Readonly<Record<string, string>>) => Effect.Effect<Record<string, string>>
  readonly list: () => Effect.Effect<Omit<Snapshot, "values">>
  readonly reveal: (confirmed: boolean) => Effect.Effect<Reveal>
  readonly ensureTemplate: () => Effect.Effect<"created" | "existing", SourceError>
  readonly subscribe: (listener: (generation: number) => void) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/LocationEnvironment") {}

export const TEMPLATE =
  "# Project environment variables for OpenCode.\n# Add NAME=value entries; never commit secrets.\n"

export function parse(source: string, content: string): { values: Record<string, string>; diagnostics: Diagnostic[] } {
  const text = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
  const values: Record<string, string> = {}
  const diagnostics: Diagnostic[] = []
  let offset = 0

  while (offset < text.length) {
    const line = position(text, offset).line
    while (text[offset] === " " || text[offset] === "\t") offset++
    if (text[offset] === "\n") {
      offset++
      continue
    }
    if (text[offset] === "#") {
      offset = nextLine(text, offset)
      continue
    }
    const start = offset
    while (offset < text.length && /[A-Za-z0-9_]/.test(text[offset] ?? "")) offset++
    const key = text.slice(start, offset)
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      diagnostics.push(
        diagnostic(source, line, start - lineStart(text, start) + 1, "invalid-key", "Expected NAME=value"),
      )
      offset = nextLine(text, offset)
      continue
    }
    while (text[offset] === " " || text[offset] === "\t") offset++
    if (text[offset] !== "=") {
      diagnostics.push(
        diagnostic(
          source,
          line,
          offset - lineStart(text, offset) + 1,
          "missing-equals",
          "Expected '=' after variable name",
        ),
      )
      offset = nextLine(text, offset)
      continue
    }
    offset++
    while (text[offset] === " " || text[offset] === "\t") offset++
    const decoded = readValue(text, offset)
    if (decoded.error) {
      const at = position(text, decoded.error.offset)
      diagnostics.push(diagnostic(source, at.line, at.column, decoded.error.code, decoded.error.message))
      offset = nextLine(text, decoded.error.offset)
      continue
    }
    if (decoded.value.includes("$(")) {
      const index = decoded.value.indexOf("$(")
      const at = position(text, offset + Math.max(index, 0))
      diagnostics.push(
        diagnostic(source, at.line, at.column, "command-substitution", "Command substitution is not allowed"),
      )
      offset = nextLine(text, decoded.end)
      continue
    }
    if (decoded.value.includes("`")) {
      const at = position(text, offset + decoded.value.indexOf("`"))
      diagnostics.push(diagnostic(source, at.line, at.column, "backtick", "Backtick execution is not allowed"))
      offset = nextLine(text, decoded.end)
      continue
    }
    values[key] = decoded.value
    offset = decoded.end
    if (text[offset] === "\n") offset++
  }
  return { values, diagnostics }
}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const source = yield* Source
    const location = yield* Location.Service
    const config = yield* Config.Service
    const global = yield* Global.Service
    const entries = yield* config.entries()
    const enabled =
      Config.latest(
        entries.filter(
          (entry) =>
            entry.type === "document" && entry.path && path.dirname(entry.path) === path.resolve(global.config),
        ),
        "experimental",
      )?.location_env === true
    const lock = Semaphore.makeUnsafe(1)
    const listeners = new Set<(generation: number) => void>()
    let current = yield* build(source, location, enabled, 1).pipe(Effect.orDie)

    return Service.of({
      snapshot: Effect.fn("LocationEnvironment.snapshot")(() => Effect.succeed(current)),
      reload: Effect.fn("LocationEnvironment.reload")(() =>
        lock.withPermit(
          build(source, location, enabled, current.generation + 1).pipe(
            Effect.tap((snapshot) =>
              Effect.sync(() => {
                current = snapshot
                listeners.forEach((listener) => listener(snapshot.generation))
              }),
            ),
          ),
        ),
      ),
      environment: Effect.fn("LocationEnvironment.environment")((explicit = {}) =>
        Effect.succeed({ ...current.values, ...explicit }),
      ),
      list: Effect.fn("LocationEnvironment.list")(() =>
        Effect.succeed({
          enabled: current.enabled,
          generation: current.generation,
          variables: current.variables,
          sources: current.sources,
        }),
      ),
      reveal: Effect.fn("LocationEnvironment.reveal")((confirmed) => {
        if (!confirmed) return Effect.succeed({ values: () => ({}), close: () => undefined })
        const values = { ...current.values }
        let open = true
        return Effect.succeed({
          values: () => (open ? { ...values } : {}),
          close: () => {
            Object.keys(values).forEach((key) => delete values[key])
            open = false
          },
        })
      }),
      ensureTemplate: Effect.fn("LocationEnvironment.ensureTemplate")(() =>
        source.ensureTemplate(location.directory, TEMPLATE),
      ),
      subscribe: Effect.fn("LocationEnvironment.subscribe")((listener) =>
        Effect.sync(() => {
          listeners.add(listener)
          return () => listeners.delete(listener)
        }),
      ),
    })
  }),
)

export const sourceDefaultLayer = Layer.effect(
  Source,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const global = yield* Global.Service
    return Source.of({
      capture: Effect.fn("LocationEnvironmentSource.capture")(function* (input) {
        const files = [
          { path: path.join(global.home, ".config", "opencode", ".env"), origin: "user" as const },
          ...directories(input.workspaceRoot, input.directory).map((directory) => ({
            path: path.join(directory, ".env"),
            origin: "project" as const,
          })),
        ]
        return {
          base: Object.fromEntries(
            Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
          ),
          files: yield* Effect.forEach(files, (file) =>
            fs.readFileString(file.path).pipe(
              Effect.map((content) => ({ ...file, content })),
              Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(file)),
              Effect.mapError(() => new SourceError({ source: file.path, code: "read-failed" })),
            ),
          ),
        }
      }),
      ensureTemplate: Effect.fn("LocationEnvironmentSource.ensureTemplate")(function* (directory, content) {
        const target = path.join(directory, ".env")
        return yield* fs.writeFileString(target, content, { flag: "wx" }).pipe(
          Effect.as("created" as const),
          Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed("existing" as const)),
          Effect.mapError(() => new SourceError({ source: target, code: "write-failed" })),
        )
      }),
    })
  }),
)

export const sourceDefaultNode = makeLocationNode({
  service: Source,
  layer: sourceDefaultLayer,
  deps: [FSUtil.node, Global.node],
})

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [sourceDefaultNode, Location.node, Config.node, Global.node],
})

function build(source: SourceInterface, location: Location.Interface, enabled: boolean, generation: number) {
  return Effect.gen(function* () {
    const capture = yield* source.capture({ workspaceRoot: location.project.directory, directory: location.directory })
    const parsed = enabled
      ? capture.files.map((file) => ({
          file,
          parsed: file.content === undefined ? undefined : parse(file.path, file.content),
        }))
      : []
    const diagnostics = parsed.flatMap((item) => item.parsed?.diagnostics ?? [])
    if (diagnostics.length) return yield* new LoadError({ diagnostics })
    const state = new Map<string, { value: string; origin: Origin; source?: string; overrides: Origin[] }>()
    Object.entries(capture.base).forEach(([name, value]) => state.set(name, { value, origin: "base", overrides: [] }))
    parsed.forEach((item) =>
      Object.entries(item.parsed?.values ?? {}).forEach(([name, value]) => {
        const previous = state.get(name)
        state.set(name, {
          value,
          origin: item.file.origin,
          source: item.file.path,
          overrides: previous ? [...previous.overrides, previous.origin] : [],
        })
      }),
    )
    return {
      enabled,
      generation,
      values: Object.freeze(Object.fromEntries([...state].map(([name, item]) => [name, item.value]))),
      variables: [...state]
        .map(([name, item]) => ({ name, origin: item.origin, source: item.source, overrides: item.overrides }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      sources: capture.files.map((file) => ({
        path: file.path,
        origin: file.origin,
        present: file.content !== undefined,
      })),
    } satisfies Snapshot
  })
}

function directories(root: string, directory: string) {
  const relative = path.relative(root, directory)
  if (relative.startsWith("..") || path.isAbsolute(relative)) return [directory]
  return relative
    .split(path.sep)
    .filter(Boolean)
    .reduce((items, segment) => [...items, path.join(items.at(-1) ?? root, segment)], [root])
}

function readValue(
  text: string,
  start: number,
): {
  value: string
  end: number
  error?: { offset: number; code: string; message: string }
} {
  if (text[start] === "'" || text[start] === '"') {
    const quote = text[start]
    let offset = start + 1
    let value = ""
    while (offset < text.length && text[offset] !== quote) {
      if (quote === '"' && text[offset] === "\\") {
        const escaped = text[offset + 1]
        const mapped = escaped === "n" ? "\n" : escaped === "r" ? "\r" : escaped === "t" ? "\t" : escaped
        if (mapped === undefined)
          return { value: "", end: offset, error: { offset, code: "invalid-escape", message: "Incomplete escape" } }
        value += mapped
        offset += 2
        continue
      }
      value += text[offset]
      offset++
    }
    if (text[offset] !== quote)
      return {
        value: "",
        end: offset,
        error: { offset: start, code: "unclosed-quote", message: "Unclosed quoted value" },
      }
    offset++
    while (text[offset] === " " || text[offset] === "\t") offset++
    if (text[offset] === "#") offset = nextLine(text, offset)
    if (text[offset] !== "\n" && offset < text.length)
      return {
        value: "",
        end: offset,
        error: { offset, code: "trailing-content", message: "Unexpected content after value" },
      }
    return { value, end: offset }
  }
  const end = text.indexOf("\n", start)
  const lineEnd = end === -1 ? text.length : end
  const raw = text.slice(start, lineEnd)
  const comment = raw.search(/(?:^|\s)#/)
  return { value: (comment === -1 ? raw : raw.slice(0, comment)).trim(), end: lineEnd }
}

function position(text: string, offset: number) {
  const before = text.slice(0, offset)
  const lines = before.split("\n")
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 }
}

function lineStart(text: string, offset: number) {
  return text.lastIndexOf("\n", offset - 1) + 1
}

function nextLine(text: string, offset: number) {
  const next = text.indexOf("\n", offset)
  return next === -1 ? text.length : next + 1
}

function diagnostic(source: string, line: number, column: number, code: string, message: string): Diagnostic {
  return { source, line, column, code, message }
}
