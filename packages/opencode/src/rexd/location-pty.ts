import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { EventV2 } from "@opencode-ai/core/event"
import { Location } from "@opencode-ai/core/location"
import { LocationEnvironment } from "@opencode-ai/core/location-environment"
import { Pty } from "@opencode-ai/core/pty"
import { PtyID } from "@opencode-ai/core/pty/schema"
import { Effect, Layer, Result, Schema } from "effect"
import { RexdLocationSession } from "./location-session"

const Opened = Schema.Struct({ pty_id: Schema.String, process_id: Schema.String })
const Output = Schema.Struct({ pty_id: Schema.String, data: Schema.String, encoding: Schema.optional(Schema.String) })
const Exit = Schema.Struct({ pty_id: Schema.String, exit_code: Schema.Number })
const BUFFER_LIMIT = 2 * 1024 * 1024

type Session = {
  info: Pty.Info
  remoteID: string
  buffer: string
  start: number
  cursor: number
  subscribers: Set<{
    active: boolean
    pending: string[]
    onData(chunk: string): void
    onEnd(event: { exitCode?: number }): void
  }>
}

export function rexdPtyNode(session: ReturnType<typeof import("./location-session").rexdSessionNode>) {
  return makeLocationNode({
    service: Pty.Service,
    layer: Layer.effect(
      Pty.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        const location = yield* Location.Service
        const environment = yield* LocationEnvironment.Service
        const events = yield* EventV2.Service
        const sessions = new Map<PtyID, Session>()
        const notify = lease.client.onNotification((method, params) => {
          if (method === "pty.output") {
            const decoded = Schema.decodeUnknownResult(Output)(params)
            if (Result.isFailure(decoded)) return
            const found = [...sessions.values()].find((item) => item.remoteID === decoded.success.pty_id)
            if (!found) return
            const chunk = Buffer.from(
              decoded.success.data,
              decoded.success.encoding === "base64" ? "base64" : "utf8",
            ).toString()
            found.cursor += chunk.length
            found.buffer += chunk
            if (found.buffer.length > BUFFER_LIMIT) {
              const excess = found.buffer.length - BUFFER_LIMIT
              found.buffer = found.buffer.slice(excess)
              found.start += excess
            }
            found.subscribers.forEach((subscriber) => {
              if (!subscriber.active) return void subscriber.pending.push(chunk)
              subscriber.onData(chunk)
            })
            return
          }
          if (method !== "pty.exit") return
          const decoded = Schema.decodeUnknownResult(Exit)(params)
          if (Result.isFailure(decoded)) return
          const found = [...sessions.values()].find((item) => item.remoteID === decoded.success.pty_id)
          if (!found || found.info.status === "exited") return
          found.info.status = "exited"
          found.info.exitCode = decoded.success.exit_code
          found.subscribers.forEach((subscriber) => subscriber.onEnd({ exitCode: decoded.success.exit_code }))
          found.subscribers.clear()
          Effect.runFork(events.publish(Pty.Event.Exited, { id: found.info.id, exitCode: decoded.success.exit_code }))
        })
        const closed = lease.client.onClose(() => {
          sessions.forEach((item) => {
            if (item.info.status !== "running") return
            item.info.status = "exited"
            item.subscribers.forEach((subscriber) => subscriber.onEnd({}))
            item.subscribers.clear()
          })
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            notify()
            closed()
            await Promise.all(
              [...sessions.values()]
                .filter((item) => item.info.status === "running")
                .map((item) => request(lease, "pty.close", item.remoteID)),
            )
          }),
        )
        const requireSession = Effect.fn("RexdPty.require")(function* (id: PtyID) {
          const found = sessions.get(id)
          if (!found) return yield* new Pty.NotFoundError({ ptyID: id })
          return found
        })
        const create = Effect.fn("RexdPty.create")(function* (input: Pty.CreateInput) {
          const id = PtyID.ascending()
          const command = input.command ?? "/bin/sh"
          const env = yield* environment.environment(input.env)
          const opened = yield* Effect.promise(() =>
            lease.client.request(
              "pty.open",
              {
                session_id: lease.handshake.sessionID,
                argv: [command, ...(input.args ?? [])],
                cwd: input.cwd ?? location.directory,
                env,
                cols: 120,
                rows: 32,
              },
              { sideEffect: true },
            ),
          ).pipe(Effect.map(Schema.decodeUnknownSync(Opened)))
          const info: Pty.Info = {
            id,
            title: input.title ?? `Terminal ${id.slice(-4)}`,
            command,
            args: [...(input.args ?? [])],
            cwd: input.cwd ?? location.directory,
            status: "running",
            pid: numericID(opened.process_id),
          }
          sessions.set(id, { info, remoteID: opened.pty_id, buffer: "", start: 0, cursor: 0, subscribers: new Set() })
          yield* events.publish(Pty.Event.Created, { info })
          return info
        })
        const remove = Effect.fn("RexdPty.remove")(function* (id: PtyID) {
          const found = yield* requireSession(id)
          if (found.info.status === "running") yield* Effect.promise(() => request(lease, "pty.close", found.remoteID))
          sessions.delete(id)
          found.subscribers.forEach((subscriber) => subscriber.onEnd({}))
          yield* events.publish(Pty.Event.Deleted, { id })
        })
        return Pty.Service.of({
          list: () => Effect.succeed([...sessions.values()].map((item) => item.info)),
          get: (id) =>
            Effect.gen(function* () {
              return (yield* requireSession(id)).info
            }),
          create,
          remove,
          update: (id, input) =>
            Effect.gen(function* () {
              const found = yield* requireSession(id)
              if (input.title) found.info.title = input.title
              if (input.size && found.info.status === "running")
                yield* Effect.promise(() =>
                  lease.client.request(
                    "pty.resize",
                    { session_id: lease.handshake.sessionID, pty_id: found.remoteID, ...input.size },
                    { sideEffect: true },
                  ),
                )
              yield* events.publish(Pty.Event.Updated, { info: found.info })
              return found.info
            }),
          write: (id, data) =>
            Effect.gen(function* () {
              const found = yield* requireSession(id)
              if (found.info.status === "running")
                yield* Effect.promise(() =>
                  lease.client.request(
                    "pty.input",
                    { session_id: lease.handshake.sessionID, pty_id: found.remoteID, data },
                    { sideEffect: true },
                  ),
                )
            }),
          attach: (id, input) =>
            Effect.gen(function* () {
              const found = yield* requireSession(id)
              if (found.info.status !== "running") return yield* new Pty.ExitedError({ ptyID: id })
              const subscriber = { active: false, pending: [] as string[], onData: input.onData, onEnd: input.onEnd }
              found.subscribers.add(subscriber)
              const from = input.cursor === -1 ? found.cursor : Math.max(0, input.cursor ?? 0)
              const replay = from >= found.cursor ? "" : found.buffer.slice(Math.max(0, from - found.start))
              return {
                replay,
                cursor: found.cursor,
                write: (data: string) =>
                  void Effect.runFork(requestEffect(lease, "pty.input", found.remoteID, { data })),
                activate: () => {
                  if (subscriber.active) return
                  subscriber.active = true
                  subscriber.pending.splice(0).forEach(subscriber.onData)
                },
                detach: () => found.subscribers.delete(subscriber),
              }
            }),
        })
      }),
    ),
    deps: [session, Location.node, LocationEnvironment.node, EventV2.node],
  })
}

function request(lease: import("./connection").RexdLease, method: string, ptyID: string) {
  return lease.client
    .request(method, { session_id: lease.handshake.sessionID, pty_id: ptyID }, { sideEffect: true })
    .then(() => undefined)
}

function requestEffect(lease: import("./connection").RexdLease, method: string, ptyID: string, params: object) {
  return Effect.promise(() =>
    lease.client.request(
      method,
      { session_id: lease.handshake.sessionID, pty_id: ptyID, ...params },
      { sideEffect: true },
    ),
  )
}

function numericID(value: string) {
  return [...value].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 0)
}
