import path from "node:path"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RelativePath } from "@opencode-ai/core/schema"
import { ReadToolFileSystem } from "@opencode-ai/core/tool/read-filesystem"
import { Effect, Layer } from "effect"
import { RexdFiles } from "./location-files"
import { RexdLocationSession } from "./location-session"

export function rexdReadNode(
  session: ReturnType<typeof import("./location-session").rexdSessionNode>,
  targetID: string,
  directory: string,
) {
  return makeLocationNode({
    service: ReadToolFileSystem.Service,
    layer: Layer.effect(
      ReadToolFileSystem.Service,
      Effect.gen(function* () {
        const files = new RexdFiles(targetID, yield* RexdLocationSession)
        return ReadToolFileSystem.Service.of({
          inspect: (input) =>
            Effect.gen(function* () {
              const stat = yield* Effect.promise(() => files.stat(input, directory))
              if (stat.type === "file") return "file" as const
              if (stat.type === "dir") return "directory" as const
              return yield* new ReadToolFileSystem.PathKindError({ resource: input, expected: "a file or directory" })
            }),
          read: (input, resource, page = {}) =>
            Effect.gen(function* () {
              const stat = yield* Effect.promise(() => files.stat(input, directory))
              if (stat.type !== "file")
                return yield* new ReadToolFileSystem.PathKindError({ resource, expected: "a file" })
              const content = (yield* Effect.promise(() => files.read(input, directory))).content
              if (content.includes(0)) return yield* new ReadToolFileSystem.BinaryFileError({ resource })
              const text = yield* Effect.try({
                try: () => new TextDecoder("utf-8", { fatal: true }).decode(content),
                catch: () => new ReadToolFileSystem.MalformedUtf8Error({ resource }),
              })
              if (content.length <= ReadToolFileSystem.MAX_READ_BYTES && !page.offset && !page.limit)
                return {
                  uri: `rexd://${encodeURIComponent(targetID)}${input}`,
                  name: path.posix.basename(input),
                  content: text,
                  encoding: "utf8" as const,
                  mime: FSUtil.mimeType(input),
                }
              const offset = page.offset ?? 1
              const lines = text.split(/\r?\n/)
              if (offset > lines.length) return yield* new ReadToolFileSystem.OffsetOutOfRangeError({ offset })
              const limit = Math.min(page.limit ?? ReadToolFileSystem.MAX_READ_LINES, ReadToolFileSystem.MAX_READ_LINES)
              const selected = lines.slice(offset - 1, offset - 1 + limit)
              const next = offset - 1 + selected.length < lines.length ? offset + selected.length : undefined
              return new ReadToolFileSystem.TextPage({
                type: "text-page",
                content: selected.join("\n").slice(0, ReadToolFileSystem.MAX_READ_BYTES),
                mime: FSUtil.mimeType(input),
                offset,
                truncated: next !== undefined,
                ...(next ? { next } : {}),
              })
            }),
          list: (input, page = {}) =>
            Effect.promise(async () => {
              const offset = page.offset ?? 1
              const limit = Math.min(page.limit ?? ReadToolFileSystem.MAX_READ_LINES, ReadToolFileSystem.MAX_READ_LINES)
              const entries = (await files.list(input, directory))
                .flatMap((item) =>
                  item.type === "file" || item.type === "dir"
                    ? [
                        FileSystem.Entry.make({
                          path: RelativePath.make(item.name + (item.type === "dir" ? "/" : "")),
                          type: item.type === "dir" ? "directory" : "file",
                        }),
                      ]
                    : [],
                )
                .sort((a, b) => (a.type === b.type ? a.path.localeCompare(b.path) : a.type === "directory" ? -1 : 1))
              const selected = entries.slice(offset - 1, offset - 1 + limit)
              const next = offset - 1 + selected.length < entries.length ? offset + selected.length : undefined
              return new ReadToolFileSystem.ListPage({
                entries: selected,
                truncated: next !== undefined,
                ...(next ? { next } : {}),
              })
            }),
        })
      }),
    ),
    deps: [session],
  })
}
