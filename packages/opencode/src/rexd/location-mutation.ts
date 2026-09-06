import path from "node:path"
import { KeyedMutex } from "@opencode-ai/core/effect/keyed-mutex"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { FileMutation } from "@opencode-ai/core/file-mutation"
import { LocationMutation } from "@opencode-ai/core/location-mutation"
import { Effect, Layer } from "effect"
import { contains, RexdFiles } from "./location-files"
import { RexdLocationSession } from "./location-session"

export function rexdMutationNodes(
  session: ReturnType<typeof import("./location-session").rexdSessionNode>,
  targetID: string,
  directory: string,
) {
  const make = Effect.gen(function* () {
    const files = new RexdFiles(targetID, yield* RexdLocationSession)
    const locks = KeyedMutex.makeUnsafe<string>()
    const resolve = LocationMutation.Service.of({
      resolve: Effect.fn("RexdLocationMutation.resolve")(function* (input) {
        const relative = !path.posix.isAbsolute(input.path)
        const absolute = path.posix.resolve(directory, input.path)
        if (relative && !contains(directory, absolute))
          return yield* new LocationMutation.PathError({ path: input.path, reason: "relative_escape" })
        const canonical = files.resolve(absolute, directory)
        const stat = yield* Effect.promise(() => files.stat(canonical, directory))
        const external = !contains(directory, canonical)
        const boundary = input.kind === "directory" && stat.type === "dir" ? canonical : path.posix.dirname(canonical)
        const resource = external ? canonical : path.posix.relative(directory, canonical) || "."
        return {
          canonical,
          resource,
          externalDirectory: external
            ? {
                action: "external_directory" as const,
                directory: boundary,
                resource: `${boundary}/*`,
                save: `${boundary}/*`,
              }
            : undefined,
        }
      }),
    })
    const result = (target: FileMutation.Target, existed: boolean): FileMutation.WriteResult => ({
      operation: "write",
      target: target.canonical,
      resource: target.resource,
      existed,
    })
    const mutation = FileMutation.Service.of({
      create: (input) =>
        locks.withLock(input.target.canonical)(
          Effect.tryPromise({
            try: async () => {
              const stat = await files.stat(input.target.canonical, directory)
              if (stat.exists) throw new FileMutation.TargetExistsError({ path: input.target.canonical })
              await files.write(input.target.canonical, directory, bytes(input.content), { mode: "create" })
              return result(input.target, false)
            },
            catch: (cause) => cause as FileMutation.TargetExistsError,
          }),
        ),
      write: (input) =>
        locks.withLock(input.target.canonical)(
          Effect.promise(async () => {
            const existed = (await files.stat(input.target.canonical, directory)).exists
            await files.write(input.target.canonical, directory, bytes(input.content))
            return result(input.target, existed)
          }),
        ),
      writeTextPreservingBom: (input) =>
        locks.withLock(input.target.canonical)(
          Effect.promise(async () => {
            const stat = await files.stat(input.target.canonical, directory)
            const current = stat.exists ? (await files.read(input.target.canonical, directory)).content : undefined
            const text = input.content.replace(/^\uFEFF+/, "")
            const bom = input.content.length !== text.length || Boolean(current && hasBom(current))
            await files.write(input.target.canonical, directory, Buffer.from(bom ? `\uFEFF${text}` : text))
            return result(input.target, stat.exists)
          }),
        ),
      writeIfUnchanged: (input) =>
        locks.withLock(input.target.canonical)(
          Effect.gen(function* () {
            const current = yield* Effect.promise(() => files.read(input.target.canonical, directory))
            if (!Buffer.from(current.content).equals(Buffer.from(input.expected)))
              return yield* new FileMutation.StaleContentError({ path: input.target.canonical })
            yield* Effect.promise(() =>
              files.write(input.target.canonical, directory, bytes(input.content), { expectedMtime: current.mtime }),
            )
            return result(input.target, true)
          }),
        ),
      remove: (input) =>
        locks.withLock(input.target.canonical)(
          Effect.promise(async () => {
            const existed = (await files.stat(input.target.canonical, directory)).exists
            if (existed) await yieldPatch(files, input.target.canonical, directory)
            return {
              operation: "remove" as const,
              target: input.target.canonical,
              resource: input.target.resource,
              existed,
            }
          }),
        ),
    })
    return { resolve, mutation }
  })
  return [
    makeLocationNode({
      service: LocationMutation.Service,
      layer: Layer.effect(LocationMutation.Service, make.pipe(Effect.map((value) => value.resolve))),
      deps: [session],
    }),
    makeLocationNode({
      service: FileMutation.Service,
      layer: Layer.effect(FileMutation.Service, make.pipe(Effect.map((value) => value.mutation))),
      deps: [session],
    }),
  ] as const
}

function bytes(content: string | Uint8Array) {
  return typeof content === "string" ? Buffer.from(content) : content
}

function hasBom(content: Uint8Array) {
  return content[0] === 0xef && content[1] === 0xbb && content[2] === 0xbf
}

async function yieldPatch(files: RexdFiles, target: string, directory: string) {
  return files.lease.client.request(
    "fs.patch",
    {
      session_id: files.lease.handshake.sessionID,
      cwd: path.posix.dirname(target),
      patch_text: `*** Begin Patch\n*** Delete File: ${path.posix.basename(target)}\n*** End Patch`,
    },
    { sideEffect: true },
  )
}
