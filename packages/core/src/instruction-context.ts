export * as InstructionContext from "./instruction-context"

import path from "node:path"
import { Array, Context, DateTime, Effect, Exit, Layer, Schema } from "effect"
import { eq } from "drizzle-orm"
import { ModelContext } from "@opencode-ai/schema/model-context"
import { ModelContextOperationEvent } from "@opencode-ai/schema/model-context-operation-event"
import { Config } from "./config"
import { ControllerFileSystem } from "./controller-filesystem"
import { makeLocationNode } from "./effect/app-node"
import { Flag } from "./flag/flag"
import { FSUtil } from "./fs-util"
import { Global } from "./global"
import { Location } from "./location"
import { SystemContext } from "./system-context/index"
import { SystemContextRegistry } from "./system-context/registry"
import { Hash } from "./util/hash"
import { Database } from "./database/database"
import { EventV2 } from "./event"
import { SessionContextEpoch } from "./session/context-epoch"
import { SessionEvent } from "./session/event"
import { SessionMessage } from "./session/message"
import { SessionSchema } from "./session/schema"
import { SessionContextEpochTable } from "./session/sql"
import { KeyedMutex } from "./effect/keyed-mutex"

const key = SystemContext.Key.make("core/instructions")
const fallbackNames = ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"] as const

type Side = "controller" | "target"
type Scope = "global" | "project" | "nested"
type Origin = ModelContext.Instruction["origin"]

export interface Interface {
  /** Admit rules below the initial Session directory before returning read/list content to the model. */
  readonly extend: (input: {
    readonly sessionID: SessionSchema.ID
    readonly path: string
    readonly kind: "file" | "directory"
  }) => Effect.Effect<void>
  /** Explicit generation boundary used only after a successful `/init` workflow. */
  readonly reload: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const targetFS = yield* FSUtil.Service
    const controllerFS = yield* ControllerFileSystem.Service
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const registry = yield* SystemContextRegistry.Service
    const { db } = yield* Database.Service
    const events = yield* EventV2.Service
    const locks = KeyedMutex.makeUnsafe<SessionSchema.ID>()

    const source = (load: Effect.Effect<ModelContext.Instructions>) =>
      SystemContext.make({
        key,
        refresh: "generation",
        allowEmpty: true,
        codec: Schema.toCodecJson(ModelContext.Instructions),
        load,
        baseline: render,
        update: (_previous, current) => {
          const text = render(current)
          return text.length === 0
            ? "Previously loaded ambient instructions no longer apply."
            : `These instructions replace all previously loaded ambient instructions.\n\n${text}`
        },
        removed: () => "Previously loaded ambient instructions no longer apply.",
      })

    const display = (value: string, side: Side) => {
      if (value.startsWith("https://") || value.startsWith("http://")) return value
      if (side === "target") return value
      const normalized = path.resolve(value)
      const configRoot = path.resolve(global.config)
      const home = path.resolve(global.home)
      if (normalized === configRoot) return "<user-config>"
      if (normalized.startsWith(`${configRoot}${path.sep}`))
        return `<user-config>/${path.relative(configRoot, normalized).replaceAll(path.sep, "/")}`
      if (normalized === home) return "~"
      if (normalized.startsWith(`${home}${path.sep}`))
        return `~/${path.relative(home, normalized).replaceAll(path.sep, "/")}`
      return normalized
    }

    const instruction = (input: {
      side: Side
      identity: string
      origin: Origin
      scope: Scope
      source: string
      declaredBy?: string
      content?: string
      failureStage?: "discovery" | "read" | "fetch"
    }) =>
      ModelContext.Instruction.make({
        id: `instruction:${Hash.sha256(`${input.side}:${input.identity}`)}`,
        origin: input.origin,
        scope: input.scope,
        source: display(input.source, input.side),
        declaredBy: input.declaredBy,
        status: input.failureStage ? "ignored" : "loaded",
        failureStage: input.failureStage,
        content: input.content,
        digest: input.content === undefined ? undefined : Hash.sha256(input.content),
      })

    const ignored = Effect.fn("InstructionContext.ignored")(function* (input: {
      side: Side
      identity: string
      origin: Origin
      scope: Scope
      source: string
      declaredBy?: string
      failureStage: "discovery" | "read" | "fetch"
    }) {
      const item = instruction(input)
      yield* Effect.logWarning("instruction source ignored", {
        source: item.source,
        stage: input.failureStage,
        scope: input.scope,
      })
      return item
    })

    const read = Effect.fn("InstructionContext.read")(function* (input: {
      filesystem: FSUtil.Interface
      side: Side
      filepath: string
      origin: Origin
      scope: Scope
      declaredBy?: string
    }) {
      const content = yield* input.filesystem
        .readFileStringSafe(input.filepath)
        .pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (content === undefined)
        return yield* ignored({
          ...input,
          identity: input.filepath,
          source: input.filepath,
          failureStage: "read",
        })
      return instruction({
        ...input,
        identity: input.filepath,
        source: input.filepath,
        content,
      })
    })

    const globalFile = Effect.fn("InstructionContext.globalFile")(function* () {
      const candidates = [
        { filepath: path.join(global.config, "AGENTS.md"), origin: "global-file" as const },
        ...(!Flag.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT
          ? [{ filepath: path.join(global.home, ".claude", "CLAUDE.md"), origin: "global-file" as const }]
          : []),
      ]
      for (const candidate of candidates) {
        if (!(yield* controllerFS.existsSafe(candidate.filepath))) continue
        return [
          yield* read({
            filesystem: controllerFS,
            side: "controller",
            filepath: candidate.filepath,
            origin: candidate.origin,
            scope: "global",
          }),
        ]
      }
      return []
    })

    const projectFiles = Effect.fn("InstructionContext.projectFiles")(function* () {
      if (Flag.OPENCODE_DISABLE_PROJECT_CONFIG) return []
      const boundaries = yield* Effect.all(
        [
          targetFS.resolve(location.canonicalDirectory ?? location.directory),
          targetFS.resolve(location.project.directory),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.exit)
      if (Exit.isFailure(boundaries))
        return [
          yield* ignored({
            side: "target",
            identity: `${location.project.directory}:${location.directory}:boundary`,
            origin: "project-file",
            scope: "project",
            source: location.directory,
            failureStage: "discovery",
          }),
        ]
      const [start, stop] = boundaries.value
      const api = pathFor("target")
      if (!contains(api, stop, start)) return []
      const discovered = yield* targetFS.up({ targets: [...fallbackNames], start, stop }).pipe(Effect.exit)
      if (Exit.isFailure(discovered))
        return [
          yield* ignored({
            side: "target",
            identity: `${stop}:${start}:automatic`,
            origin: "project-file",
            scope: "project",
            source: stop,
            failureStage: "discovery",
          }),
        ]
      const selected = fallbackNames
        .map((name) => discovered.value.filter((item) => api.basename(item) === name))
        .find((items) => items.length > 0)
      if (!selected) return []
      const ordered = selected.toSorted((left, right) => depth(api, stop, left) - depth(api, stop, right))
      return yield* Effect.forEach(
        ordered,
        (filepath) =>
          read({
            filesystem: targetFS,
            side: "target",
            filepath,
            origin: "project-file",
            scope: "project",
          }),
        { concurrency: "unbounded" },
      )
    })

    const fetchInstruction = Effect.fn("InstructionContext.fetch")(function* (
      url: string,
      declaredBy: string,
      scope: "global" | "project",
    ) {
      const content = yield* Effect.tryPromise({
        try: async () => {
          const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return response.text()
        },
        catch: () => new Error("Instruction URL fetch failed"),
      }).pipe(Effect.exit)
      if (Exit.isFailure(content))
        return yield* ignored({
          side: "controller",
          identity: url,
          origin: "configured-url",
          scope,
          source: url,
          declaredBy,
          failureStage: "fetch",
        })
      return instruction({
        side: "controller",
        identity: url,
        origin: "configured-url",
        scope,
        source: url,
        declaredBy,
        content: content.value,
      })
    })

    const configuredFiles = Effect.fn("InstructionContext.configuredFiles")(function* (input: {
      raw: string
      document: Config.Document
      side: Side
      filesystem: FSUtil.Interface
      declaredBy: string
      scope: "global" | "project"
    }) {
      const api = pathFor(input.side)
      const home = input.side === "controller" ? global.home : location.home
      if (input.raw.startsWith("~/") && !home)
        return [
          yield* ignored({
            side: input.side,
            identity: `${input.declaredBy}:${input.raw}`,
            origin: "configured-file",
            scope: input.scope,
            source: input.raw,
            declaredBy: input.declaredBy,
            failureStage: "discovery",
          }),
        ]
      const base = input.document.path ? api.dirname(input.document.path) : location.directory
      const expanded = input.raw.startsWith("~/") ? api.join(home!, input.raw.slice(2)) : input.raw
      const pattern = api.isAbsolute(expanded) ? api.normalize(expanded) : api.resolve(base, expanded)
      if (!hasGlob(pattern))
        return [
          yield* read({
            filesystem: input.filesystem,
            side: input.side,
            filepath: pattern,
            origin: "configured-file",
            scope: input.scope,
            declaredBy: input.declaredBy,
          }),
        ]

      const root = api.parse(pattern).root
      const matches = yield* input.filesystem
        .glob(api.relative(root, pattern), { cwd: root, absolute: true, include: "file", dot: true })
        .pipe(Effect.exit)
      if (Exit.isFailure(matches) || matches.value.length === 0)
        return [
          yield* ignored({
            side: input.side,
            identity: `${input.declaredBy}:${input.raw}`,
            origin: "configured-file",
            scope: input.scope,
            source: pattern,
            declaredBy: input.declaredBy,
            failureStage: "discovery",
          }),
        ]
      return yield* Effect.forEach(
        matches.value.toSorted(),
        (filepath) =>
          read({
            filesystem: input.filesystem,
            side: input.side,
            filepath,
            origin: "configured-file",
            scope: input.scope,
            declaredBy: input.declaredBy,
          }),
        { concurrency: "unbounded" },
      )
    })

    const configured = Effect.fn("InstructionContext.configured")(function* (scope: "global" | "project") {
      const documents = (yield* config.entries()).filter(
        (entry): entry is Config.Document =>
          entry.type === "document" &&
          entry.info.instructions !== undefined &&
          (entry.scope ?? (entry.filesystem === "controller" ? "global" : "project")) === scope,
      )
      const result: ModelContext.Instruction[] = []
      for (const document of documents) {
        const side = document.filesystem ?? (scope === "global" ? "controller" : "target")
        const filesystem = side === "controller" ? controllerFS : targetFS
        const declaredBy = document.path ? display(document.path, side) : "<configuration>"
        for (const raw of document.info.instructions ?? []) {
          if (raw.startsWith("https://") || raw.startsWith("http://")) {
            result.push(yield* fetchInstruction(raw, declaredBy, scope))
            continue
          }
          result.push(...(yield* configuredFiles({ raw, document, side, filesystem, declaredBy, scope })))
        }
      }
      return result
    })

    const observeSources = Effect.fn("InstructionContext.observeSources")(function* () {
      return yield* Effect.all([globalFile(), configured("global"), projectFiles(), configured("project")], {
        concurrency: "unbounded",
      }).pipe(Effect.map((groups) => Array.dedupeWith(groups.flat(), (left, right) => left.id === right.id)))
    })

    const observe = Effect.fn("InstructionContext.observe")(function* () {
      if (location.target.type !== "rexd") return yield* observeSources()
      const id = crypto.randomUUID()
      const target = location.targetName ?? location.lastKnownTargetName ?? "remote"
      yield* events.publish(ModelContextOperationEvent.Updated, {
        progress: { id, target, state: "active", phase: "discover instructions" },
      })
      return yield* observeSources().pipe(
        Effect.tap((items) => {
          const failed = items.find((item) => item.status === "ignored")
          return events.publish(ModelContextOperationEvent.Updated, {
            progress: failed
              ? {
                  id,
                  target,
                  state: "failed",
                  phase: failed.failureStage ?? "load",
                  source: failed.source,
                  detail: `${items.filter((item) => item.status === "ignored").length} instruction source(s) ignored`,
                }
              : { id, target, state: "idle", phase: "discover instructions" },
          })
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? events.publish(ModelContextOperationEvent.Updated, {
                progress: {
                  id,
                  target,
                  state: "failed",
                  phase: "discover instructions",
                  detail: "model context discovery failed",
                },
              })
            : Effect.void,
        ),
      )
    })

    yield* registry.register({
      key,
      load: Effect.succeed(source(observe())),
    })

    const extendOnce = Effect.fn("InstructionContext.extendOnce")(function* (input: {
      readonly sessionID: SessionSchema.ID
      readonly path: string
      readonly kind: "file" | "directory"
    }) {
      const row = yield* db
        .select()
        .from(SessionContextEpochTable)
        .where(eq(SessionContextEpochTable.session_id, input.sessionID))
        .get()
        .pipe(Effect.orDie)
      if (!row) return
      const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(row.snapshot).pipe(Effect.orDie)
      const current = snapshot[key]?.value
      const instructions = current
        ? yield* Schema.decodeUnknownEffect(ModelContext.Instructions)(current).pipe(Effect.orDie)
        : ModelContext.Instructions.make([])
      const api = pathFor("target")
      const logical = api.normalize(location.directory)
      const canonical = api.normalize(location.canonicalDirectory ?? location.directory)
      const requested = api.normalize(input.kind === "directory" ? input.path : api.dirname(input.path))
      const relative = contains(api, logical, requested)
        ? api.relative(logical, requested)
        : contains(api, canonical, requested)
          ? api.relative(canonical, requested)
          : undefined
      if (relative === undefined || relative === "") return
      const directory = api.join(canonical, relative)
      if (!contains(api, canonical, directory)) return
      const discovered = yield* targetFS
        .up({ targets: [...fallbackNames], start: directory, stop: canonical })
        .pipe(Effect.exit)
      if (Exit.isFailure(discovered)) {
        yield* Effect.logWarning("nested instruction discovery ignored", { path: directory })
        return
      }
      const selected = fallbackNames
        .map((name) => discovered.value.filter((item) => api.basename(item) === name))
        .find((items) => items.length > 0)
      if (!selected) return
      const known = new Set(instructions.map((item) => item.id))
      const additions = (yield* Effect.forEach(
        selected.toSorted((left, right) => depth(api, canonical, left) - depth(api, canonical, right)),
        (filepath) =>
          read({
            filesystem: targetFS,
            side: "target",
            filepath,
            origin: "nested-file",
            scope: "nested",
          }),
        { concurrency: "unbounded" },
      )).filter((item) => !known.has(item.id))
      if (additions.length === 0) return
      const next = ModelContext.Instructions.make([...instructions, ...additions])
      const rendered = yield* SystemContext.initialize(source(Effect.succeed(next)))
      const sources = { ...snapshot, [key]: rendered.snapshot[key]! }
      yield* events.publish(SessionEvent.ContextAdvanced, {
        sessionID: input.sessionID,
        messageID: SessionMessage.ID.create(),
        timestamp: yield* DateTime.now,
        cause: "nested-instructions",
        text: render(additions),
        sources,
        digest: SessionContextEpoch.digest(sources),
      })
    })

    const extend = (input: Parameters<Interface["extend"]>[0]) =>
      locks
        .withLock(input.sessionID)(extendOnce(input))
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("nested instruction extension ignored", { path: input.path, cause }),
          ),
        )

    const reload = (sessionID: SessionSchema.ID) =>
      locks
        .withLock(sessionID)(
          Effect.gen(function* () {
            const row = yield* db
              .select()
              .from(SessionContextEpochTable)
              .where(eq(SessionContextEpochTable.session_id, sessionID))
              .get()
              .pipe(Effect.orDie)
            if (!row) return
            const snapshot = yield* Schema.decodeUnknownEffect(SystemContext.Snapshot)(row.snapshot).pipe(Effect.orDie)
            const previous = snapshot[key]
              ? yield* Schema.decodeUnknownEffect(ModelContext.Instructions)(snapshot[key]!.value).pipe(Effect.orDie)
              : ModelContext.Instructions.make([])
            // `/init` owns the initial chain. Nested rules already admitted by
            // read/list stay frozen unless their file no longer exists in this
            // Location, so an init does not silently hot-reload deeper rules.
            const nested = yield* Effect.filter(
              previous.filter((item) => item.origin === "nested-file"),
              (item) => targetFS.existsSafe(item.source),
              { concurrency: "unbounded" },
            )
            const initial = yield* observe()
            const known = new Set(initial.map((item) => item.id))
            const instructions = ModelContext.Instructions.make([
              ...initial,
              ...nested.filter((item) => !known.has(item.id)),
            ])
            const rendered = yield* SystemContext.initialize(source(Effect.succeed(instructions)))
            const sources = { ...snapshot, [key]: rendered.snapshot[key]! }
            const context = yield* registry.load()
            const replacement = SystemContext.rebaseline(context, sources)
            if (replacement._tag === "ReplacementBlocked") {
              yield* Effect.logWarning("instruction context reload blocked", { sessionID })
              return
            }
            yield* events.publish(SessionEvent.ContextGenerationEstablished, {
              sessionID,
              timestamp: yield* DateTime.now,
              context: SessionContextEpoch.materialize(replacement.generation, {
                generation: row.generation + 1,
                reason: "init",
                locationRevision: row.location_revision,
              }),
            })
          }),
        )
        .pipe(
          Effect.catchCause((cause) => Effect.logWarning("instruction context reload ignored", { sessionID, cause })),
        )

    return Service.of({ extend, reload })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Config.node,
    ControllerFileSystem.node,
    Database.node,
    EventV2.node,
    FSUtil.locationNode,
    Global.node,
    Location.node,
    SystemContextRegistry.node,
  ],
})

function render(instructions: ModelContext.Instructions) {
  return instructions
    .filter((item) => item.status === "loaded" && item.content !== undefined && item.content.length > 0)
    .map((item) => `Instructions from: ${item.source}\n${item.content}`)
    .join("\n\n")
}

function pathFor(side: Side) {
  return side === "target" ? path.posix : path
}

function contains(api: path.PlatformPath, parent: string, child: string) {
  const relative = api.relative(parent, child)
  return relative === "" || (!api.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${api.sep}`))
}

function depth(api: path.PlatformPath, root: string, value: string) {
  return api.relative(root, api.dirname(value)).split(api.sep).filter(Boolean).length
}

function hasGlob(value: string) {
  return /[*?{}[\]]/.test(value)
}
