import { randomUUID } from "node:crypto"
import { makeLocationNode } from "@opencode-ai/core/effect/app-node"
import { SessionSchema } from "@opencode-ai/core/session/schema"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillPackageAccess } from "@opencode-ai/core/skill/package-access"
import { SkillPackageSnapshot } from "@opencode-ai/core/skill/package-snapshot"
import { Effect, Layer } from "effect"
import { RexdLocationSession } from "./location-session"
import { RexdSkillMaterializer } from "./skill-materializer"
import type { RexdLease } from "./connection"

const appID = `${process.pid}:${randomUUID()}`

export type Materializer = Pick<RexdSkillMaterializer.Materializer, "materialize" | "close">

export type Dependencies = {
  readonly makeMaterializer?: (targetID: string, lease: RexdLease, appID: string) => Materializer
}

export function rexdSkillPackageAccessNode(
  session: ReturnType<typeof import("./location-session").rexdSessionNode>,
  targetID: string,
  dependencies: Dependencies = {},
) {
  return makeLocationNode({
    service: SkillPackageAccess.Service,
    layer: Layer.effect(
      SkillPackageAccess.Service,
      Effect.gen(function* () {
        const snapshots = yield* SkillPackageSnapshot.Service
        const lease = yield* RexdLocationSession
        const materializer = dependencies.makeMaterializer
          ? dependencies.makeMaterializer(targetID, lease, appID)
          : new RexdSkillMaterializer.Materializer(targetID, lease, appID)
        const prepared = new Map<string, Promise<RexdSkillMaterializer.Attachment>>()
        yield* Effect.addFinalizer(() => Effect.promise(() => materializer.close()))

        return SkillPackageAccess.Service.of({
          prepare: Effect.fn("RexdSkillPackageAccess.prepare")(function* (input) {
            const snapshot = yield* snapshots.create(input.entry).pipe(
              Effect.mapError(
                () =>
                  new SkillPackageAccess.Failure({
                    skillID: input.entry.metadata.id,
                    kind: "unavailable",
                  }),
              ),
            )
            const key = `${input.sessionID}\0${snapshot.digest}`
            const existing = prepared.get(key)
            const attachment = yield* Effect.tryPromise({
              try: () => {
                if (existing) return existing
                const current = materializer
                  .materialize(snapshot, SessionSchema.ID.make(input.sessionID), input.signal)
                  .catch((error) => {
                    prepared.delete(key)
                    throw error
                  })
                prepared.set(key, current)
                return current
              },
              catch: () =>
                new SkillPackageAccess.Failure({
                  skillID: input.entry.metadata.id,
                  kind: "unavailable",
                }),
            })
            return {
              path: AbsolutePath.make(attachment.path),
              temporary: true,
            }
          }),
        })
      }),
    ),
    deps: [session, SkillPackageSnapshot.node],
  })
}
