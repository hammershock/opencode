import { Location } from "@opencode-ai/core/location"
import { Project } from "@opencode-ai/core/project"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Effect, Layer } from "effect"
import { tmpdir } from "./tmpdir"

export function location(
  value: Parameters<typeof Location.Ref.make>[0],
  input: { projectDirectory?: AbsolutePath; canonicalDirectory?: AbsolutePath; vcs?: Project.Vcs } = {},
) {
  const ref = Location.Ref.make(value)
  return {
    target: ref.target,
    directory: ref.directory,
    canonicalDirectory: input.canonicalDirectory ?? ref.directory,
    workspaceID: ref.workspaceID,
    project: { id: Project.ID.global, directory: input.projectDirectory ?? ref.directory },
    vcs: input.vcs,
    platform: `${process.platform}-${process.arch}`,
    targetName: ref.lastKnownTargetName ?? "local",
  } satisfies Location.Interface
}

export const tempLocationLayer = Layer.unwrap(
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.map((tmp) => {
      const ref = Location.Ref.make({ directory: AbsolutePath.make(tmp.path) })
      return Layer.succeed(Location.Service, Location.Service.of(location(ref)))
    }),
  ),
)
