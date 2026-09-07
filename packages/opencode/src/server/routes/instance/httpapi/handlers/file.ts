import * as InstanceState from "@/effect/instance-state"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Location } from "@opencode-ai/core/location"
import { RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer, Option } from "effect"
import ignore from "ignore"
import path from "path"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const fileHandlers = HttpApiBuilder.group(InstanceHttpApi, "file", (handlers) =>
  Effect.gen(function* () {
    const findText = Effect.fn("FileHttpApi.findText")(function* (ctx: { query: { pattern: string } }) {
      return (yield* FileSystem.Service.use((fs) =>
        fs.grep(new FileSystem.GrepInput({ pattern: ctx.query.pattern, limit: 10 })),
      )).map((match) => ({
        path: { text: match.entry.path },
        lines: { text: match.text },
        line_number: match.line,
        absolute_offset: match.offset,
        submatches: match.submatches.map((submatch) => ({
          match: { text: submatch.text },
          start: submatch.start,
          end: submatch.end,
        })),
      }))
    })

    const findFile = Effect.fn("FileHttpApi.findFile")(function* (ctx: {
      query: { query: string; dirs?: "true" | "false"; type?: "file" | "directory"; limit?: number }
    }) {
      const directory = (yield* InstanceState.context).directory
      const limit = ctx.query.limit ?? 10
      const type = ctx.query.type ?? (ctx.query.dirs === "false" ? "file" : undefined)
      const started = performance.now()
      const found = yield* FileSystem.Service.use((fs) => fs.find({ query: ctx.query.query, limit, type }))
      yield* Effect.logInfo("find file", {
        query: ctx.query.query,
        type,
        directory,
        limit,
        results: found.length,
        duration: Math.round(performance.now() - started),
      })
      return found.map((item) => item.path)
    })

    const findSymbol = Effect.fn("FileHttpApi.findSymbol")(function* () {
      return []
    })

    const list = Effect.fn("FileHttpApi.list")(function* (ctx: { query: { path: string } }) {
      const directory = (yield* InstanceState.context).directory
      return yield* Effect.gen(function* () {
        const fs = yield* FileSystem.Service
        const raw = yield* FSUtil.Service
        const location = yield* Location.Service
        const ignored = ignore()
        const gitignore = yield* raw
          .readFileString(path.join(location.project.directory, ".gitignore"))
          .pipe(Effect.catch(() => Effect.succeed("")))
        if (gitignore) ignored.add(gitignore)
        const ignorefile = yield* raw
          .readFileString(path.join(location.project.directory, ".ignore"))
          .pipe(Effect.catch(() => Effect.succeed("")))
        if (ignorefile) ignored.add(ignorefile)
        return (yield* fs.list({ path: RelativePath.make(ctx.query.path) })).map((item) => ({
          name: path.basename(item.path),
          path: item.path,
          absolute: path.resolve(location.directory, item.path),
          type: item.type,
          ignored: ignored.ignores(
            path.relative(location.project.directory, path.resolve(location.directory, item.path)) +
              (item.type === "directory" ? "/" : ""),
          ),
        }))
      })
    })

    const content = Effect.fn("FileHttpApi.content")(function* (ctx: { query: { path: string } }) {
      const item = yield* FileSystem.Service.use((fs) => fs.read({ path: RelativePath.make(ctx.query.path) })).pipe(
        Effect.option,
      )
      if (Option.isNone(item)) return { type: "text" as const, content: "" }
      const text = item.value.content.includes(0)
        ? Option.none<string>()
        : yield* Effect.sync(() => new TextDecoder("utf-8", { fatal: true }).decode(item.value.content)).pipe(
            Effect.option,
          )
      if (Option.isSome(text)) return { type: "text" as const, content: text.value.trim() }
      return {
        type: "binary" as const,
        content: Buffer.from(item.value.content).toString("base64"),
        encoding: "base64" as const,
        mimeType: item.value.mime,
      }
    })

    const status = Effect.fn("FileHttpApi.status")(function* () {
      return []
    })

    return handlers
      .handle("findText", findText)
      .handle("findFile", findFile)
      .handle("findSymbol", findSymbol)
      .handle("list", list)
      .handle("content", content)
      .handle("status", status)
  }),
)
