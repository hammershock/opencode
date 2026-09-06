import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { Snapshot } from "@opencode-ai/core/snapshot"
import { Effect, Layer } from "effect"

/**
 * rexd/1 has no remote Git snapshot protocol. Keep the feature explicitly
 * unavailable instead of probing the controller at the remote path.
 */
export const rexdSnapshotNode = makeLocationNode({
  service: Snapshot.Service,
  layer: Layer.succeed(
    Snapshot.Service,
    Snapshot.Service.of({
      capture: () => Effect.succeed(undefined),
      files: () => Effect.fail(unavailable("files")),
      diff: () => Effect.fail(unavailable("diff")),
      preview: () => Effect.fail(unavailable("preview")),
      restore: () => Effect.fail(unavailable("restore")),
      checkout: () => Effect.fail(unavailable("restore")),
    }),
  ),
  deps: [],
})

function unavailable(operation: "files" | "diff" | "preview" | "restore") {
  return new Snapshot.Error({ operation, message: "Remote snapshots require a future Rexd protocol capability" })
}
