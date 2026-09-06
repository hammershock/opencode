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
import { runRexdProcess } from "./location-process"

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
    const lease = yield* RexdLocationSession
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
      grep: (input) => remoteGrep(files, lease, directory, input),
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

export function remoteGrep(
  files: RexdFiles,
  lease: import("./connection").RexdLease,
  directory: string,
  input: FileSystem.GrepInput,
) {
  return Effect.promise(async () => {
    const root = files.resolve(input.path ?? ".", directory)
    const stat = await files.stat(root, directory)
    const cwd = stat.type === "file" ? path.posix.dirname(root) : root
    const target = stat.type === "file" ? path.posix.basename(root) : "."
    // rexd/1 has no structured grep method. Keep this compatibility adapter
    // provider-private and use an explicit argv; never download the tree to the controller.
    const result = await runRexdProcess(lease, {
      argv: [
        "grep",
        "-R",
        "-n",
        "-H",
        "-I",
        "-Z",
        "--exclude-dir=.git",
        ...(input.include ? [`--include=${input.include}`] : []),
        "--",
        input.pattern,
        target,
      ],
      shell: false,
      cwd,
      timeout: "2 minutes",
      maxOutputBytes: 8 * 1024 * 1024,
    })
    if (result.exitCode !== 0 && result.exitCode !== 1)
      throw new Error(result.stderr.toString("utf8") || `Remote grep exited with ${result.exitCode}`)
    return result.stdout
      .toString("utf8")
      .split("\n")
      .flatMap((line) => {
        const separator = line.indexOf("\0")
        if (separator === -1) return []
        const match = line.slice(separator + 1).match(/^(\d+):(.*)$/)
        if (!match) return []
        return [
          FileSystem.Match.make({
            entry: FileSystem.Entry.make({
              path: RelativePath.make(path.posix.relative(directory, files.resolve(line.slice(0, separator), cwd))),
              type: "file",
            }),
            line: Number(match[1]),
            offset: 0,
            text: match[2]!.slice(0, 2_000),
            submatches: [],
          }),
        ]
      })
      .slice(0, input.limit ?? Number.MAX_SAFE_INTEGER)
  })
}
