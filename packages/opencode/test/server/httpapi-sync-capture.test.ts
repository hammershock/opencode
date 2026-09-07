import { describe, expect, test } from "bun:test"
import { Database } from "@opencode-ai/core/database/database"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2 } from "@opencode-ai/core/event"
import { SyncDatabase } from "@opencode-ai/core/sync/database"
import { SyncEventStore } from "@opencode-ai/core/sync/event-store"
import { SessionSync } from "@opencode-ai/core/sync/session"
import { Effect, Schema } from "effect"
import { EventV2Bridge } from "@/event-v2-bridge"
import { HttpApiApp } from "@/server/routes/instance/httpapi/server"
import { testEffect } from "../lib/effect"

const Created = EventV2.define({
  type: "session.created",
  durable: { version: 1, aggregate: "sessionID" },
  schema: {
    sessionID: Schema.String,
    info: Schema.Struct({ syncSpaceID: Schema.String }),
  },
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([EventV2Bridge.node, SyncEventStore.node]), [
    [Database.node, Database.layerFromPath(":memory:")],
    [SyncDatabase.node, SyncDatabase.layerFromPath(":memory:")],
  ]),
)

describe("HTTP server sync capture graph", () => {
  test("includes the SessionSync capture node", () => {
    expect(HttpApiApp.app.dependencies).toContain(SessionSync.node)
  })

  it.live("captures an assigned Session only in its target space", () =>
    Effect.gen(function* () {
      const events = yield* EventV2Bridge.Service
      const store = yield* SyncEventStore.Service
      yield* events.publish(Created, {
        sessionID: "assigned-session",
        info: { syncSpaceID: "target-space" },
      })

      expect((yield* store.scope("target-space").pending(10)).map((event) => event.aggregateID)).toEqual([
        "assigned-session",
      ])
      expect(yield* store.pending(10)).toEqual([])
    }),
  )
})
