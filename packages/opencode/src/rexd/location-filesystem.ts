import path from "node:path"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RelativePath } from "@opencode-ai/core/schema"
import { Effect, Layer } from "effect"
import fuzzysort from "fuzzysort"
import { RexdFiles } from "./location-files"
import { RexdLocationSession } from "./location-session"

export function rexdFilesystemNodes(
  session: ReturnType<typeof import("./location-session").rexdSessionNode>,
  targetID: string,
  directory: string,
) {
  const make = Effect.gen(function* () {
    const files = new RexdFiles(targetID, yield* RexdLocationSession)
    const relative = (value: string) => RelativePath.make(path.posix.relative(directory, value))
    const entry = (item: { path: string; type: string }) =>
      item.type === "file" || item.type === "dir"
        ? FileSystem.Entry.make({
            path: RelativePath.make(relative(files.resolve(item.path, directory)) + (item.type === "dir" ? "/" : "")),
            type: item.type === "dir" ? "directory" : "file",
          })
        : undefined
    const search = FileSystemSearch.Service.of({
      find: (input) =>
        Effect.promise(async () => {
          const entries = (await files.list(".", directory, true)).map(entry).filter((item) => item !== undefined)
          const selected = input.type ? entries.filter((item) => item.type === input.type) : entries
          return fuzzysort.go(input.query, selected, { key: "path", limit: input.limit ?? 50 }).map((item) => item.obj)
        }),
      glob: (input) =>
        Effect.promise(async () =>
          (await files.glob(input.pattern, path.posix.resolve(directory, input.path ?? "."))).map((item) =>
            FileSystem.Entry.make({ path: relative(files.resolve(item, directory)), type: "file" }),
          ),
        ),
      grep: (input) => remoteGrep(files, directory, input),
    })
    return {
      search,
      filesystem: FileSystem.Service.of({
        find: search.find,
        glob: search.glob,
        grep: search.grep,
        read: (input) =>
          Effect.promise(async () => ({
            content: (await files.read(input.path, directory)).content,
            mime: FSUtil.mimeType(input.path),
          })),
        list: (input = {}) =>
          Effect.promise(async () =>
            (await files.list(input.path ?? ".", directory)).map(entry).filter((item) => item !== undefined),
          ),
      }),
    }
  })
  const search = makeLocationNode({
    service: FileSystemSearch.Service,
    layer: Layer.effect(FileSystemSearch.Service, make.pipe(Effect.map((value) => value.search))),
    deps: [session],
  })
  return [
    search,
    makeLocationNode({
      service: FileSystem.Service,
      layer: Layer.effect(FileSystem.Service, make.pipe(Effect.map((value) => value.filesystem))),
      deps: [session, search],
    }),
  ] as const
}

function remoteGrep(files: RexdFiles, directory: string, input: FileSystem.GrepInput) {
  return Effect.promise(async () => {
    const root = files.resolve(input.path ?? ".", directory)
    const entries = await files.list(root, directory, true)
    const matches: FileSystem.Match[] = []
    for (const item of entries) {
      if (item.type !== "file") continue
      if (input.include && !new Bun.Glob(input.include).match(item.path)) continue
      const content = Buffer.from((await files.read(item.path, directory)).content).toString("utf8")
      content.split("\n").forEach((text, index) => {
        if (!text.includes(input.pattern) || matches.length >= (input.limit ?? Number.MAX_SAFE_INTEGER)) return
        matches.push(
          FileSystem.Match.make({
            entry: FileSystem.Entry.make({
              path: RelativePath.make(path.posix.relative(directory, item.path)),
              type: "file",
            }),
            line: index + 1,
            offset: 0,
            text: text.slice(0, 2_000),
            submatches: [],
          }),
        )
      })
    }
    return matches
  })
}
