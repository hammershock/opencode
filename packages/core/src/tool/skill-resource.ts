export * as SkillResourceTool from "./skill-resource"

import path from "path"
import { ToolFailure } from "@opencode-ai/llm"
import { Skill } from "@opencode-ai/schema/skill"
import { SkillResource } from "@opencode-ai/schema/skill-resource"
import { Effect, FileSystem, Layer, Option, Schema } from "effect"
import { ControllerFileSystem } from "../controller-filesystem"
import { makeLocationNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { PermissionV2 } from "../permission"
import { AbsolutePath, NonNegativeInt, RelativePath } from "../schema"
import { SkillResolver } from "../skill/resolver"
import { Hash } from "../util/hash"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"

export const name = "skill_resource"

export const description = [
  "Read auxiliary files from a previously admitted Skill package.",
  "Pass the invocation ID shown on the loaded skill instructions, or a local Skill ID returned by the skill tool.",
  "Omit resource to list a bounded manifest. File reads support UTF-8 text only and return an opaque cursor when another page is available.",
  "This tool never exposes controller paths, executes files, or falls back to the Session filesystem.",
].join("\n")

export class AccessError extends Schema.TaggedErrorClass<AccessError>()("SkillResource.AccessError", {
  kind: SkillResource.FailureKind,
}) {}

const ManifestCursor = Schema.Struct({
  type: Schema.Literal("manifest"),
  offset: NonNegativeInt,
  digest: Skill.Digest,
})
const TextCursor = Schema.Struct({
  type: Schema.Literal("text"),
  offset: NonNegativeInt,
  digest: Skill.Digest,
})
const Cursor = Schema.Union([ManifestCursor, TextCursor]).pipe(Schema.toTaggedUnion("type"))

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const fs = yield* ControllerFileSystem.Service
    const permission = yield* PermissionV2.Service
    const resolver = yield* SkillResolver.Service
    const tools = yield* Tools.Service
    yield* tools
      .register({
        [name]: Tool.withPermission(
          Tool.make({
            description,
            input: SkillResource.Input,
            output: SkillResource.Output,
            toModelOutput: ({ output }) => [{ type: "text", text: JSON.stringify(output) }],
            execute: (input, context) =>
              Effect.gen(function* () {
                const candidate = yield* resolver
                  .resolve({ sessionID: context.sessionID, agent: context.agent, reference: input.skill })
                  .pipe(Effect.mapError((error) => failure(error.kind)))
                yield* permission
                  .assert({
                    action: "skill",
                    resources: [candidate.entry.metadata.name],
                    save: [candidate.entry.metadata.name],
                    sessionID: context.sessionID,
                    agent: context.agent,
                    source: { type: "tool", messageID: context.assistantMessageID, callID: context.toolCallID },
                  })
                  .pipe(Effect.mapError(() => failure("permission_denied")))
                const resolved = yield* resolver.read(candidate).pipe(Effect.mapError((error) => failure(error.kind)))
                const root = yield* packageRoot(fs, resolved.entry).pipe(
                  Effect.mapError((error) => failure(error.kind)),
                )
                const identity = SkillResource.Identity.make({
                  ...(resolved.invocationID === undefined ? {} : { invocationID: resolved.invocationID }),
                  skillID: resolved.entry.metadata.id,
                  name: resolved.entry.metadata.name,
                  digest: resolved.entry.metadata.digest,
                })
                if (input.resource === undefined)
                  return yield* manifest(fs, root, identity, input.cursor).pipe(
                    Effect.mapError((error) => failure(error.kind)),
                  )
                return yield* read(fs, root, identity, input.resource, input.cursor).pipe(
                  Effect.mapError((error) => failure(error.kind)),
                )
              }),
          }),
          "skill",
        ),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/skill-resource",
  layer,
  deps: [ToolRegistry.node, ControllerFileSystem.node, PermissionV2.node, SkillResolver.node],
})

const packageRoot = Effect.fn("SkillResource.packageRoot")(function* (
  fs: FSUtil.Interface,
  entry: SkillResolver.Resolved["entry"],
) {
  if (entry.source.kind === "built-in" || path.basename(entry.location) !== "SKILL.md")
    return yield* new AccessError({ kind: "resource_unavailable_on_device" })
  const expected = path.dirname(entry.location)
  const root = yield* fs
    .realPath(expected)
    .pipe(Effect.mapError(() => new AccessError({ kind: "resource_unavailable_on_device" })))
  if (!samePath(root, expected)) return yield* new AccessError({ kind: "resource_outside_package" })
  const skill = yield* fs
    .realPath(entry.location)
    .pipe(Effect.mapError(() => new AccessError({ kind: "resource_unavailable_on_device" })))
  if (!samePath(skill, entry.location) || !FSUtil.contains(root, skill))
    return yield* new AccessError({ kind: "resource_outside_package" })
  return AbsolutePath.make(root)
})

const manifest = Effect.fn("SkillResource.manifest")(function* (
  fs: FSUtil.Interface,
  root: AbsolutePath,
  identity: SkillResource.Identity,
  encodedCursor?: string,
) {
  const pending = [""]
  const entries: SkillResource.Entry[] = []
  let scanned = 0
  let limited = false
  while (pending.length > 0 && !limited) {
    const directory = pending.shift()!
    const absolute = directory === "" ? root : nativePath(root, directory)
    const children = yield* fs
      .readDirectoryEntries(absolute)
      .pipe(Effect.mapError(() => new AccessError({ kind: "resource_unavailable_on_device" })))
    for (const child of children.toSorted((a, b) => a.name.localeCompare(b.name))) {
      scanned++
      if (scanned > SkillResource.MAX_MANIFEST_SCAN_ENTRIES) {
        limited = true
        break
      }
      const resource = directory === "" ? child.name : `${directory}/${child.name}`
      if (resource === "SKILL.md" || child.type === "symlink" || child.type === "other") continue
      if (validateResource(resource) !== resource) continue
      const target = nativePath(root, resource)
      const real = yield* fs.realPath(target).pipe(Effect.catch(() => Effect.void))
      if (!real || !samePath(real, target) || !FSUtil.contains(root, real)) continue
      const info = yield* fs.stat(real).pipe(Effect.catch(() => Effect.void))
      if (!info) continue
      if (child.type === "directory" && info.type === "Directory") {
        pending.push(resource)
        continue
      }
      if (child.type !== "file" || info.type !== "File" || hardlinked(info.nlink)) continue
      entries.push(
        SkillResource.Entry.make({
          resource: RelativePath.make(resource),
          size: Number(info.size),
          mime: FSUtil.mimeType(resource),
        }),
      )
    }
  }
  entries.sort((a, b) => a.resource.localeCompare(b.resource))
  const digest = Skill.Digest.make(
    Hash.sha256(JSON.stringify(entries.map((entry) => [entry.resource, entry.size, entry.mime]))),
  )
  const cursor = encodedCursor === undefined ? undefined : yield* decodeCursor(encodedCursor)
  if (cursor && (cursor.type !== "manifest" || cursor.digest !== digest))
    return yield* new AccessError({ kind: "invalid_cursor" })
  const offset = cursor?.offset ?? 0
  if (offset > entries.length) return yield* new AccessError({ kind: "invalid_cursor" })
  const selected = entries.slice(offset, offset + SkillResource.MAX_MANIFEST_ENTRIES)
  const next = offset + selected.length
  const hasNext = next < entries.length
  return SkillResource.Manifest.make({
    type: "manifest",
    skill: identity,
    entries: selected,
    truncated: hasNext || limited,
    ...(hasNext ? { nextCursor: encodeCursor({ type: "manifest", offset: next, digest }) } : {}),
    ...(limited ? { diagnostic: "manifest_limit" as const } : {}),
  })
})

const read = Effect.fn("SkillResource.read")(function* (
  fs: FSUtil.Interface,
  root: AbsolutePath,
  identity: SkillResource.Identity,
  requested: string,
  encodedCursor?: string,
) {
  const resource = validateResource(requested)
  if (!resource) return yield* new AccessError({ kind: "invalid_resource_path" })
  const target = nativePath(root, resource)
  const real = yield* fs.realPath(target).pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
  if (!samePath(real, target) || !FSUtil.contains(root, real))
    return yield* new AccessError({ kind: "resource_outside_package" })
  const before = yield* fs.stat(real).pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
  if (before.type !== "File") return yield* new AccessError({ kind: "unsupported_resource_type" })
  if (hardlinked(before.nlink)) return yield* new AccessError({ kind: "resource_outside_package" })
  const size = Number(before.size)
  const mime = FSUtil.mimeType(resource)
  if (size > SkillResource.MAX_RESOURCE_BYTES)
    return SkillResource.Unsupported.make({
      type: "unsupported",
      skill: identity,
      resource: RelativePath.make(resource),
      mime,
      size,
      diagnostic: "resource_too_large",
    })
  const bytes = yield* readStable(fs, real, before).pipe(
    Effect.mapError((error) => new AccessError({ kind: error.kind })),
  )
  const digest = Skill.Digest.make(Hash.sha256(Buffer.from(bytes)))
  if (binary(bytes))
    return SkillResource.Unsupported.make({
      type: "unsupported",
      skill: identity,
      resource: RelativePath.make(resource),
      mime,
      size: bytes.length,
      digest,
      diagnostic: "binary",
    })
  const text = decodeText(bytes)
  if (text === undefined)
    return SkillResource.Unsupported.make({
      type: "unsupported",
      skill: identity,
      resource: RelativePath.make(resource),
      mime,
      size: bytes.length,
      digest,
      diagnostic: "binary",
    })
  const cursor = encodedCursor === undefined ? undefined : yield* decodeCursor(encodedCursor)
  if (cursor && (cursor.type !== "text" || cursor.digest !== digest || cursor.offset >= bytes.length))
    return yield* new AccessError({ kind: "invalid_cursor" })
  const offset = cursor?.offset ?? 0
  const end = pageEnd(bytes, offset)
  const content = decodeText(bytes.subarray(offset, end))
  if (content === undefined) return yield* new AccessError({ kind: "invalid_cursor" })
  return SkillResource.Text.make({
    type: "text",
    skill: identity,
    resource: RelativePath.make(resource),
    mime,
    size: bytes.length,
    digest,
    content,
    truncated: end < bytes.length,
    ...(end < bytes.length ? { nextCursor: encodeCursor({ type: "text", offset: end, digest }) } : {}),
  })
})

const readStable = Effect.fn("SkillResource.readStable")(function* (
  fs: FSUtil.Interface,
  target: string,
  before: FileSystem.File.Info,
) {
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs
        .open(target, { flag: "r" })
        .pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
      const opened = yield* file.stat.pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
      if (opened.type !== "File") return yield* new AccessError({ kind: "unsupported_resource_type" })
      if (hardlinked(opened.nlink) || !sameFile(before, opened))
        return yield* new AccessError({ kind: "resource_outside_package" })
      const chunks: Uint8Array[] = []
      let total = 0
      while (total <= SkillResource.MAX_RESOURCE_BYTES) {
        const chunk = yield* file
          .readAlloc(Math.min(64 * 1024, SkillResource.MAX_RESOURCE_BYTES + 1 - total))
          .pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
        if (Option.isNone(chunk)) break
        chunks.push(chunk.value)
        total += chunk.value.length
      }
      if (total > SkillResource.MAX_RESOURCE_BYTES) return yield* new AccessError({ kind: "unsupported_resource_type" })
      const current = yield* fs
        .realPath(target)
        .pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
      const after = yield* fs.stat(current).pipe(Effect.mapError(() => new AccessError({ kind: "resource_not_found" })))
      if (!samePath(current, target) || !sameFile(opened, after))
        return yield* new AccessError({ kind: "resource_outside_package" })
      return new Uint8Array(
        Buffer.concat(
          chunks.map((chunk) => Buffer.from(chunk)),
          total,
        ),
      )
    }),
  )
})

function validateResource(value: string) {
  if (
    value.length === 0 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    path.win32.isAbsolute(value) ||
    /%[0-9a-f]{2}/i.test(value)
  )
    return
  const segments = value.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return
  if (value === "SKILL.md") return
  return segments.join("/")
}

function nativePath(root: string, resource: string) {
  return path.join(root, ...resource.split("/"))
}

function samePath(a: string, b: string) {
  return path.normalize(a) === path.normalize(b)
}

function hardlinked(nlink: Option.Option<number>) {
  return (Option.getOrUndefined(nlink) ?? 1) > 1
}

function sameFile(a: FileSystem.File.Info, b: FileSystem.File.Info) {
  const left = Option.getOrUndefined(a.ino)
  const right = Option.getOrUndefined(b.ino)
  const sameIdentity = left !== undefined && right !== undefined ? a.dev === b.dev && left === right : a.type === b.type
  const leftModified = Option.getOrUndefined(a.mtime)?.getTime()
  const rightModified = Option.getOrUndefined(b.mtime)?.getTime()
  return (
    sameIdentity &&
    a.size === b.size &&
    (leftModified === undefined || rightModified === undefined || leftModified === rightModified)
  )
}

function binary(bytes: Uint8Array) {
  if (bytes.length === 0) return false
  let control = 0
  for (const byte of bytes) {
    if (byte === 0) return true
    if (byte < 9 || (byte > 13 && byte < 32)) control++
  }
  return control / bytes.length > 0.3
}

function decodeText(bytes: Uint8Array) {
  return Effect.runSync(
    Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () => undefined,
    }),
  )
}

function pageEnd(bytes: Uint8Array, offset: number) {
  const boundary = Math.min(offset + SkillResource.MAX_PAGE_BYTES, bytes.length)
  if (boundary === bytes.length) return boundary
  let end = boundary
  while (end > offset && (bytes[end]! & 0xc0) === 0x80) end--
  return end
}

function encodeCursor(cursor: typeof Cursor.Type) {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url")
}

const decodeJson = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)
const decodeCursorValue = Schema.decodeUnknownOption(Cursor)

function decodeCursor(value: string) {
  if (value.length === 0 || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value))
    return Effect.fail(new AccessError({ kind: "invalid_cursor" }))
  const json = decodeJson(Buffer.from(value, "base64url").toString("utf8")).valueOrUndefined
  const cursor = decodeCursorValue(json).valueOrUndefined
  return cursor ? Effect.succeed(cursor) : Effect.fail(new AccessError({ kind: "invalid_cursor" }))
}

function failure(kind: SkillResource.FailureKind) {
  return new ToolFailure({ message: `skill_resource failed: ${kind}` })
}
