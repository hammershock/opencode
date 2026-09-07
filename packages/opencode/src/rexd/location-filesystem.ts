import path from "node:path"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { FileSystem } from "@opencode-ai/core/filesystem"
import { FileSystemSearch } from "@opencode-ai/core/filesystem/search"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { RelativePath } from "@opencode-ai/core/schema"
import { Effect, FileSystem as PlatformFileSystem, Layer, Option } from "effect"
import * as PlatformError from "effect/PlatformError"
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
        directoryStatus: (input) =>
          Effect.promise(async () => {
            const result = await files.stat(input, directory)
            return {
              status: result.exists ? (result.type === "dir" ? "directory" : "not-directory") : "missing",
              path: files.resolve(input, directory),
            } as const
          }),
        ensureDirectory: (input) =>
          Effect.promise(async () => {
            const target = files.resolve(input, directory)
            await runRexdProcess(lease, {
              argv: ["mkdir", "-p", "--", target],
              shell: false,
              cwd: directory,
              timeout: "30 seconds",
              maxOutputBytes: 64 * 1024,
            }).then((result) => {
              if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"))
            })
            return { status: "directory", path: target } as const
          }),
      }),
    }
  })
  const search = makeLocationNode({
    service: FileSystemSearch.Service,
    layer: Layer.effect(FileSystemSearch.Service, make.pipe(Effect.map((value) => value.search))),
    deps: [session],
  })
  const legacy = makeLocationNode({
    service: FSUtil.Service,
    layer: Layer.effect(
      FSUtil.Service,
      Effect.gen(function* () {
        const lease = yield* RexdLocationSession
        const files = new RexdFiles(targetID, lease)
        const unsupported =
          (method: string) =>
          (..._args: unknown[]) =>
            Effect.die(new Error(`Remote filesystem operation is not supported: ${method}`))
        const absolute = (value: string) => files.resolve(value, directory)
        const stat = (value: string) =>
          Effect.promise(async () => {
            const item = await files.stat(value, directory)
            if (!item.exists) throw new Error(`Remote path does not exist: ${absolute(value)}`)
            return {
              type:
                item.type === "dir"
                  ? ("Directory" as const)
                  : item.type === "symlink"
                    ? ("SymbolicLink" as const)
                    : ("File" as const),
              mtime: item.mtime == null ? Option.none() : Option.some(new Date(item.mtime)),
              atime: Option.none(),
              birthtime: Option.none(),
              dev: 0,
              ino: Option.none(),
              mode: 0,
              nlink: Option.none(),
              uid: Option.none(),
              gid: Option.none(),
              rdev: Option.none(),
              size: PlatformFileSystem.Size(0),
              blksize: Option.none(),
              blocks: Option.none(),
            }
          })
        const entries = (value: string) =>
          Effect.promise(() => files.list(value, directory)).pipe(
            Effect.map((items) =>
              items.map((item) => ({
                name: item.name,
                type:
                  item.type === "dir"
                    ? ("directory" as const)
                    : item.type === "file"
                      ? ("file" as const)
                      : item.type === "symlink"
                        ? ("symlink" as const)
                        : ("other" as const),
              })),
            ),
          )
        const read = (value: string) =>
          Effect.tryPromise({
            try: () => files.read(value, directory),
            catch: (cause) =>
              PlatformError.systemError({
                _tag: cause instanceof Error && cause.message.includes("no such file") ? "NotFound" : "Unknown",
                module: "FileSystem",
                method: "readFile",
                pathOrDescriptor: value,
                cause,
              }),
          }).pipe(Effect.map((x) => x.content))
        const write = (value: string, content: Uint8Array) =>
          Effect.promise(() => files.write(value, directory, content))
        const ensure = (value: string) =>
          Effect.promise(() =>
            runRexdProcess(lease, {
              argv: ["mkdir", "-p", "--", absolute(value)],
              shell: false,
              cwd: directory,
              timeout: "30 seconds",
              maxOutputBytes: 64 * 1024,
            }).then((result) => {
              if (result.exitCode !== 0) throw new Error(result.stderr.toString("utf8"))
            }),
          )
        const methods: Partial<FSUtil.Interface> = {
          resolve: (value) => Effect.succeed(absolute(value)),
          realPath: (value) => stat(value).pipe(Effect.as(absolute(value))),
          exists: (value) => Effect.promise(() => files.stat(value, directory)).pipe(Effect.map((x) => x.exists)),
          existsSafe: (value) =>
            Effect.promise(() => files.stat(value, directory)).pipe(
              Effect.map((x) => x.exists),
              Effect.orElseSucceed(() => false),
            ),
          isDir: (value) =>
            Effect.promise(() => files.stat(value, directory)).pipe(
              Effect.map((x) => x.type === "dir"),
              Effect.orElseSucceed(() => false),
            ),
          isFile: (value) =>
            Effect.promise(() => files.stat(value, directory)).pipe(
              Effect.map((x) => x.type === "file"),
              Effect.orElseSucceed(() => false),
            ),
          stat,
          readFile: read,
          readFileString: (value) => read(value).pipe(Effect.map((x) => Buffer.from(x).toString("utf8"))),
          readFileStringSafe: (value) =>
            read(value).pipe(
              Effect.map((x) => Buffer.from(x).toString("utf8")),
              Effect.orElseSucceed(() => undefined),
            ),
          writeFile: write,
          writeFileString: (value, content) => write(value, Buffer.from(content)),
          writeWithDirs: (value, content) => write(value, typeof content === "string" ? Buffer.from(content) : content),
          ensureDir: ensure,
          makeDirectory: (value) => ensure(value),
          readDirectory: (value) => entries(value).pipe(Effect.map((items) => items.map((item) => item.name))),
          readDirectoryEntries: entries,
          glob: (pattern, options) =>
            Effect.promise(() => files.glob(pattern, options?.cwd ?? directory).then((x) => [...x])),
          globMatch: (pattern, value) => new Bun.Glob(pattern).match(value),
          findUp: (target, start, stop) => upward(files, target, start, stop),
          globUp: (pattern, start, stop) => upwardGlob(files, pattern, start, stop),
          up: (input) =>
            Effect.forEach(input.targets, (target) => upward(files, target, input.start, input.stop)).pipe(
              Effect.map((x) => x.flat()),
            ),
        }
        return FSUtil.Service.of(
          new Proxy(methods as FSUtil.Interface, {
            get(target, property) {
              return Reflect.get(target, property) ?? unsupported(String(property))
            },
          }),
        )
      }),
    ),
    deps: [session],
  })
  return [
    search,
    makeLocationNode({
      service: FileSystem.Service,
      layer: Layer.effect(FileSystem.Service, make.pipe(Effect.map((value) => value.filesystem))),
      deps: [session, search],
    }),
    legacy,
  ] as const
}

function upward(files: RexdFiles, target: string, start: string, stop?: string) {
  return Effect.promise(async () => {
    const result: string[] = []
    let current = files.resolve(start, start)
    while (true) {
      const candidate = path.posix.join(current, target)
      if ((await files.stat(candidate, current)).exists) result.push(candidate)
      if (current === stop || current === "/") break
      current = path.posix.dirname(current)
    }
    return result
  })
}

function upwardGlob(files: RexdFiles, pattern: string, start: string, stop?: string) {
  return Effect.promise(async () => {
    const result: string[] = []
    let current = files.resolve(start, start)
    while (true) {
      result.push(...(await files.glob(pattern, current)))
      if (current === stop || current === "/") break
      current = path.posix.dirname(current)
    }
    return result
  })
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
