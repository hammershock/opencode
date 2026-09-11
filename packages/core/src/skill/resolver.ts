export * as SkillResolver from "./resolver"

import { Skill } from "@opencode-ai/schema/skill"
import { SkillInvocation } from "@opencode-ai/schema/skill-invocation"
import { SkillResource } from "@opencode-ai/schema/skill-resource"
import { Context, Effect, Layer, Schema } from "effect"
import { AgentV2 } from "../agent"
import { makeLocationNode } from "../effect/app-node"
import { SessionMessage } from "../session/message"
import { SessionSchema } from "../session/schema"
import { SessionStore } from "../session/store"
import { SkillV2 } from "../skill"
import { SkillGuidanceSnapshot } from "./guidance-snapshot"
import { SkillRegistry } from "./registry"

export interface Resolved {
  readonly entry: SkillRegistry.Entry
  readonly invocationID?: SkillInvocation.ID
}

export interface Interface {
  readonly resolve: (input: {
    readonly sessionID: SessionSchema.ID
    readonly agent: AgentV2.ID
    readonly reference: SkillResource.Reference
  }) => Effect.Effect<Resolved, Error>
  readonly resolveName: (input: { readonly agent: AgentV2.ID; readonly name: string }) => Effect.Effect<Resolved, Error>
  readonly read: (resolved: Resolved) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillResolver") {}

export class Error extends Schema.TaggedErrorClass<Error>()("SkillResolver.Error", {
  kind: SkillResource.FailureKind,
}) {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* AgentV2.Service
    const registry = yield* SkillRegistry.Service
    const sessions = yield* SessionStore.Service
    const skills = yield* SkillV2.Service

    const permitted = Effect.fnUntraced(function* (agent: AgentV2.ID, entries: ReadonlyArray<SkillRegistry.Entry>) {
      const selected = yield* agents.select(agent)
      const info = selected.info
      if (!info) return []
      return entries.filter((entry) => SkillV2.available([entry.metadata], info).length > 0)
    })

    const resolveSkill = Effect.fnUntraced(function* (agent: AgentV2.ID, id: Skill.ID) {
      const match = yield* skills.lookup(id)
      if (match.status === "missing") return yield* new Error({ kind: "resource_unavailable_on_device" })
      if (match.status === "target-inapplicable") return yield* new Error({ kind: "skill_inapplicable" })
      if ((yield* permitted(agent, [match.entry])).length === 0) return yield* new Error({ kind: "skill_inapplicable" })
      return { entry: match.entry }
    })

    const resolveInvocation = Effect.fnUntraced(function* (
      sessionID: SessionSchema.ID,
      agent: AgentV2.ID,
      id: SkillInvocation.ID,
    ) {
      const context = yield* sessions
        .context(sessionID)
        .pipe(Effect.mapError(() => new Error({ kind: "resource_unavailable_on_device" })))
      const snapshots = context.flatMap(invocations).filter((snapshot) => snapshot.id === id)
      const snapshot = snapshots[0]
      if (!snapshot || snapshots.some((candidate) => !sameInvocation(snapshot, candidate)))
        return yield* new Error({ kind: "resource_unavailable_on_device" })
      const catalog = yield* skills.catalog()
      const matches = catalog.entries.filter(
        (entry) =>
          entry.metadata.name === snapshot.name &&
          entry.metadata.digest === snapshot.digest &&
          entry.source.kind === snapshot.source.kind &&
          SkillGuidanceSnapshot.sourceLabel(entry.source.label) === snapshot.source.label,
      )
      if (matches.length !== 1) return yield* new Error({ kind: "resource_unavailable_on_device" })
      const applicable = yield* permitted(agent, matches)
      if (applicable.length === 0) return yield* new Error({ kind: "skill_inapplicable" })
      return { entry: applicable[0]!, invocationID: snapshot.id }
    })

    return Service.of({
      resolve: Effect.fn("SkillResolver.resolve")(function* (input) {
        if (input.reference.startsWith("ski_"))
          return yield* resolveInvocation(input.sessionID, input.agent, SkillInvocation.ID.make(input.reference))
        return yield* resolveSkill(input.agent, Skill.ID.make(input.reference))
      }),
      resolveName: Effect.fn("SkillResolver.resolveName")(function* (input) {
        const entries = (yield* permitted(input.agent, (yield* skills.catalog()).entries)).filter(
          (entry) => entry.metadata.name === input.name,
        )
        if (entries.length === 0) return yield* new Error({ kind: "resource_unavailable_on_device" })
        if (entries.length > 1) return yield* new Error({ kind: "ambiguous_skill" })
        return { entry: entries[0]! }
      }),
      read: Effect.fn("SkillResolver.read")(function* (resolved) {
        const entry = yield* registry
          .read(resolved.entry)
          .pipe(Effect.mapError(() => new Error({ kind: "resource_unavailable_on_device" })))
        return { entry, ...(resolved.invocationID === undefined ? {} : { invocationID: resolved.invocationID }) }
      }),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [AgentV2.node, SessionStore.node, SkillV2.node, SkillRegistry.node],
})

function invocations(message: SessionMessage.Message) {
  if (message.type === "user") return (message.skills ?? []).map((invocation) => invocation.snapshot)
  if (message.type === "compaction") return message.skills ?? []
  if (message.type !== "assistant") return []
  return message.content.flatMap((item) => {
    if (item.type !== "tool" || item.name !== "skill" || item.state.status !== "completed") return []
    const snapshot = Schema.decodeUnknownOption(SkillInvocation.Snapshot)(
      item.state.structured.snapshot,
    ).valueOrUndefined
    return snapshot ? [snapshot] : []
  })
}

function sameInvocation(a: SkillInvocation.Snapshot, b: SkillInvocation.Snapshot) {
  return (
    a.name === b.name &&
    a.digest === b.digest &&
    a.source.kind === b.source.kind &&
    a.source.label === b.source.label &&
    a.content === b.content &&
    a.status === b.status
  )
}
