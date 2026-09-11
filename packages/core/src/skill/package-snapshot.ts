export * as SkillPackageSnapshot from "./package-snapshot"

import path from "path"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { ControllerFileSystem } from "../controller-filesystem"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { AbsolutePath, RelativePath } from "../schema"
import { Hash } from "../util/hash"
import { SkillRegistry } from "./registry"

export const MAX_PACKAGE_BYTES = 64 * 1024 * 1024
export const MAX_FILES = 4096
export const MAX_FILE_BYTES = 16 * 1024 * 1024
export const READ_CHUNK_BYTES = 256 * 1024

export type FailureKind =
  | "unavailable"
  | "outside-package"
  | "cycle"
  | "unsupported-file"
  | "too-many-files"
  | "file-too-large"
  | "package-too-large"
  | "case-collision"
  | "unstable"

export class Failure extends Schema.TaggedErrorClass<Failure>()("SkillPackageSnapshot.Failure", {
  skillID: Skill.ID,
  kind: Schema.Literals([
    "unavailable",
    "outside-package",
    "cycle",
    "unsupported-file",
    "too-many-files",
    "file-too-large",
    "package-too-large",
    "case-collision",
    "unstable",
  ]),
}) {}

export interface File {
  readonly path: RelativePath
  readonly size: number
  readonly digest: Skill.Digest
  readonly content: Uint8Array
}

export interface Snapshot {
  readonly skillID: Skill.ID
  readonly root: AbsolutePath
  readonly files: ReadonlyArray<File>
  readonly size: number
  readonly digest: Skill.Digest
}

export interface Interface {
  readonly create: (entry: SkillRegistry.Entry) => Effect.Effect<Snapshot, Failure>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillPackageSnapshot") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* ControllerFileSystem.Service
    return Service.of({
      create: Effect.fn("SkillPackageSnapshot.create")(function* (entry) {
        if (entry.source.kind === "built-in" || path.basename(entry.location) !== "SKILL.md")
          return yield* failure(entry, "unavailable")
        const root = yield* fs
          .realPath(path.dirname(entry.location))
          .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
        const skill = yield* fs
          .realPath(entry.location)
          .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
        if (!FSUtil.contains(root, skill)) return yield* failure(entry, "outside-package")

        const state = {
          files: [] as File[],
          size: 0,
          paths: new Map<string, string>(),
        }
        yield* scanDirectory(fs, entry, AbsolutePath.make(root), root, root, "", new Set(), state)
        const files = state.files.toSorted((a, b) => compare(a.path, b.path))
        if (!files.some((file) => file.path === "SKILL.md")) return yield* failure(entry, "unavailable")
        return {
          skillID: entry.metadata.id,
          root: AbsolutePath.make(root),
          files,
          size: state.size,
          digest: Skill.Digest.make(
            Hash.sha256(JSON.stringify(files.map((file) => [file.path, file.size, file.digest]))),
          ),
        }
      }),
    })
  }),
)

type State = {
  readonly files: File[]
  size: number
  readonly paths: Map<string, string>
}

function scanDirectory(
  fs: FSUtil.Interface,
  entry: SkillRegistry.Entry,
  root: AbsolutePath,
  sourceDirectory: string,
  realDirectory: string,
  relativeDirectory: string,
  ancestors: ReadonlySet<string>,
  state: State,
): Effect.Effect<void, Failure> {
  return Effect.gen(function* () {
    if (ancestors.has(realDirectory)) return yield* failure(entry, "cycle")
    if (!FSUtil.contains(root, realDirectory)) return yield* failure(entry, "outside-package")
    const before = yield* fs
      .stat(realDirectory)
      .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
    if (before.type !== "Directory") return yield* failure(entry, "unsupported-file")
    const children = yield* fs
      .readDirectoryEntries(realDirectory)
      .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
    if (relativeDirectory && (yield* containsSkillMarker(fs, root, realDirectory, children)))
      return yield* failure(entry, "unstable")

    for (const child of children.toSorted((a, b) => compare(a.name, b.name))) {
      const sourceRelative = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
      const portable = sourceRelative
        .split("/")
        .map((segment) => segment.normalize("NFC"))
        .join("/")
      if (child.type === "other") return yield* failure(entry, "unsupported-file")
      const source = path.join(realDirectory, child.name)
      const real = yield* fs
        .realPath(source)
        .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
      if (!FSUtil.contains(root, real)) return yield* failure(entry, "outside-package")
      const info = yield* fs
        .stat(real)
        .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))

      if (info.type === "Directory") {
        if (real === realDirectory || ancestors.has(real)) return yield* failure(entry, "cycle")
        const nested = yield* fs
          .readDirectoryEntries(real)
          .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
        if (yield* containsSkillMarker(fs, root, real, nested)) continue
        yield* addPath(entry, portable, state)
        yield* scanDirectory(fs, entry, root, source, real, portable, new Set([...ancestors, realDirectory]), state)
        continue
      }
      if (info.type !== "File") return yield* failure(entry, "unsupported-file")
      yield* addPath(entry, portable, state)
      if (state.files.length >= MAX_FILES) return yield* failure(entry, "too-many-files")
      if (Number(info.size) > MAX_FILE_BYTES) return yield* failure(entry, "file-too-large")
      const content = yield* readStable(fs, entry, root, source, real, info)
      if (state.size + content.length > MAX_PACKAGE_BYTES) return yield* failure(entry, "package-too-large")
      state.size += content.length
      state.files.push({
        path: RelativePath.make(portable),
        size: content.length,
        digest: Skill.Digest.make(Hash.sha256(Buffer.from(content))),
        content,
      })
    }

    const current = yield* fs
      .realPath(sourceDirectory)
      .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unstable" })))
    const after = yield* fs
      .stat(current)
      .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unstable" })))
    if (current !== realDirectory || !sameFile(before, after)) return yield* failure(entry, "unstable")
  })
}

function addPath(entry: SkillRegistry.Entry, portable: string, state: State) {
  const collision = portable.toLowerCase()
  const previous = state.paths.get(collision)
  if (previous && previous !== portable) return Effect.fail(failure(entry, "case-collision"))
  state.paths.set(collision, portable)
  return Effect.void
}

const containsSkillMarker = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  root: AbsolutePath,
  directory: string,
  children: ReadonlyArray<FSUtil.DirEntry>,
) {
  const marker = children.find((child) => child.name === "SKILL.md")
  if (!marker || marker.type === "other") return false
  const real = yield* fs.realPath(path.join(directory, marker.name)).pipe(Effect.catch(() => Effect.void))
  if (!real || !FSUtil.contains(root, real)) return false
  const info = yield* fs.stat(real).pipe(Effect.catch(() => Effect.void))
  return info?.type === "File"
})

const readStable = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  entry: SkillRegistry.Entry,
  root: AbsolutePath,
  source: string,
  real: string,
  before: FileSystem.File.Info,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs
        .open(real, { flag: "r" })
        .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
      const opened = yield* file.stat.pipe(
        Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })),
      )
      if (opened.type !== "File") return yield* failure(entry, "unsupported-file")
      if (!sameFile(before, opened)) return yield* failure(entry, "unstable")
      const chunks: Uint8Array[] = []
      let total = 0
      while (total <= MAX_FILE_BYTES) {
        const chunk = yield* file
          .readAlloc(Math.min(READ_CHUNK_BYTES, MAX_FILE_BYTES + 1 - total))
          .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unavailable" })))
        if (Option.isNone(chunk)) break
        chunks.push(chunk.value)
        total += chunk.value.length
      }
      if (total > MAX_FILE_BYTES) return yield* failure(entry, "file-too-large")
      const current = yield* fs
        .realPath(source)
        .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unstable" })))
      const after = yield* fs
        .stat(current)
        .pipe(Effect.mapError(() => new Failure({ skillID: entry.metadata.id, kind: "unstable" })))
      if (current !== real || !FSUtil.contains(root, current) || !sameFile(opened, after))
        return yield* failure(entry, "unstable")
      return new Uint8Array(
        Buffer.concat(
          chunks.map((chunk) => Buffer.from(chunk)),
          total,
        ),
      )
    }),
  )
})

function failure(entry: SkillRegistry.Entry, kind: FailureKind) {
  return new Failure({ skillID: entry.metadata.id, kind })
}

function sameFile(a: FileSystem.File.Info, b: FileSystem.File.Info) {
  const left = Option.getOrUndefined(a.ino)
  const right = Option.getOrUndefined(b.ino)
  const identity = left !== undefined && right !== undefined ? a.dev === b.dev && left === right : a.type === b.type
  const leftModified = Option.getOrUndefined(a.mtime)?.getTime()
  const rightModified = Option.getOrUndefined(b.mtime)?.getTime()
  return (
    identity &&
    a.type === b.type &&
    a.size === b.size &&
    (leftModified === undefined || rightModified === undefined || leftModified === rightModified)
  )
}

function compare(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0
}

export const node = makeGlobalNode({ service: Service, layer, deps: [ControllerFileSystem.node] })
