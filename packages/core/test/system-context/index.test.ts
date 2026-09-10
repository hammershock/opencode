import { describe, expect } from "bun:test"
import { Cause, Effect, Exit, Schema } from "effect"
import { SystemContext } from "@opencode-ai/core/system-context"
import { it } from "../lib/effect"

const key = SystemContext.Key.make
const stringContext = (input: {
  key: string
  value: string | SystemContext.Unavailable
  refresh?: "generation" | "activation" | "turn"
  baseline?: (value: string) => string
  update?: (previous: string, current: string) => string
  removed?: (value: string) => string
  preservePrevious?: (value: string) => boolean
}) =>
  SystemContext.make({
    key: key(input.key),
    refresh: input.refresh,
    codec: Schema.toCodecJson(Schema.String),
    load: Effect.succeed(input.value),
    baseline: input.baseline ?? String,
    update: input.update ?? ((_previous, current) => current),
    removed: input.removed,
    preservePrevious: input.preservePrevious,
  })

describe("SystemContext", () => {
  it.effect("stores the canonical JSON encoding of the loaded value", () =>
    Effect.gen(function* () {
      const context = SystemContext.make({
        key: key("core/date"),
        codec: Schema.toCodecJson(Schema.DateFromString),
        load: Effect.succeed(new Date("2026-06-03T12:00:00.000Z")),
        baseline: (date) => date.toISOString(),
        update: (_previous, date) => date.toISOString(),
        removed: () => "Date removed",
      })

      expect((yield* SystemContext.initialize(context)).snapshot["core/date"].value).toBe("2026-06-03T12:00:00.000Z")
    }),
  )

  it.effect("loads once and initializes a baseline with a structured snapshot", () =>
    Effect.gen(function* () {
      let loads = 0
      const context = SystemContext.combine([
        SystemContext.make({
          key: key("core/date"),
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.sync(() => {
            loads++
            return "2026-06-03"
          }),
          baseline: (date) => `Today's date is ${date}.`,
          update: (previous, current) => `The date changed from ${previous} to ${current}.`,
          removed: () => "The date was removed.",
        }),
        stringContext({ key: "core/location", value: "/repo", baseline: (value) => `Directory: ${value}` }),
      ])

      expect(yield* SystemContext.initialize(context)).toEqual({
        baseline: "Today's date is 2026-06-03.\n\nDirectory: /repo",
        snapshot: {
          "core/date": {
            value: "2026-06-03",
            baseline: "Today's date is 2026-06-03.",
            removed: "The date was removed.",
          },
          "core/location": { value: "/repo", baseline: "Directory: /repo" },
        },
      })
      expect(loads).toBe(1)
    }),
  )

  it.effect("renders updates only after a structured value changes", () =>
    Effect.gen(function* () {
      const previous = {
        "core/date": { value: "2026-06-03", removed: "The date was removed." },
        "core/location": { value: "/repo", removed: "Removed: /repo" },
      }
      const changed = SystemContext.combine([
        stringContext({
          key: "core/date",
          value: "2026-06-04",
          update: (before, current) => `The date changed from ${before} to ${current}.`,
          removed: () => "The date was removed.",
        }),
        stringContext({ key: "core/location", value: "/repo" }),
      ])

      expect(yield* SystemContext.reconcile(changed, previous)).toEqual({
        _tag: "Updated",
        text: "The date changed from 2026-06-03 to 2026-06-04.",
        snapshot: {
          "core/date": { value: "2026-06-04", baseline: "2026-06-04", removed: "The date was removed." },
          "core/location": { value: "/repo", removed: "Removed: /repo" },
        },
      })

      expect(
        yield* SystemContext.reconcile(
          SystemContext.combine([
            stringContext({ key: "core/date", value: "2026-06-03", removed: () => "The date was removed." }),
            stringContext({ key: "core/location", value: "/repo" }),
          ]),
          previous,
        ),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("does not reload generation sources during ordinary reconciliation", () =>
    Effect.gen(function* () {
      let loads = 0
      const context = SystemContext.make({
        key: key("core/instructions"),
        refresh: "generation",
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.sync(() => {
          loads++
          return "changed on disk"
        }),
        baseline: String,
        update: (_previous, current) => current,
      })

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": { value: "accepted", refresh: "generation" },
        }),
      ).toEqual({ _tag: "Unchanged" })
      expect(loads).toBe(0)
    }),
  )

  it.effect("reloads generation sources only for an explicit replacement", () =>
    Effect.gen(function* () {
      let loads = 0
      const context = SystemContext.make({
        key: key("core/instructions"),
        refresh: "generation",
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.sync(() => {
          loads++
          return "current"
        }),
        baseline: String,
        update: (_previous, current) => current,
      })

      expect(yield* SystemContext.replace(context, { "core/instructions": { value: "accepted" } })).toMatchObject({
        _tag: "ReplacementReady",
        generation: {
          baseline: "current",
          snapshot: { "core/instructions": { value: "current", refresh: "generation" } },
        },
      })
      expect(loads).toBe(1)
    }),
  )

  it.effect("observes activation sources only at the activation boundary", () =>
    Effect.gen(function* () {
      let loads = 0
      const context = SystemContext.make({
        key: key("core/skill-guidance"),
        refresh: "activation",
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.sync(() => {
          loads++
          return "current"
        }),
        baseline: String,
        update: (_previous, current) => `Skills changed: ${current}`,
      })
      const previous = {
        "core/skill-guidance": { value: "accepted", baseline: "accepted", refresh: "activation" as const },
      }

      expect(yield* SystemContext.reconcile(context, previous)).toEqual({ _tag: "Unchanged" })
      expect(loads).toBe(0)
      expect(yield* SystemContext.reconcileActivation(context, previous)).toEqual({
        _tag: "Updated",
        text: "Skills changed: current",
        snapshot: {
          "core/skill-guidance": { value: "current", baseline: "current", refresh: "activation" },
        },
      })
      expect(loads).toBe(1)
    }),
  )

  it.effect("carries admitted activation sources through ordinary replacement without loading them", () =>
    Effect.gen(function* () {
      let activationLoads = 0
      const context = SystemContext.combine([
        stringContext({ key: "core/date", value: "current" }),
        SystemContext.make({
          key: key("core/skill-guidance"),
          refresh: "activation",
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.sync(() => {
            activationLoads++
            return "changed on disk"
          }),
          baseline: (value) => `Skills: ${value}`,
          update: (_previous, current) => `Skills: ${current}`,
        }),
      ])

      expect(
        yield* SystemContext.reconcile(context, {
          "core/date": { value: 42 },
          "core/skill-guidance": {
            value: "accepted",
            baseline: "Skills: accepted",
            refresh: "activation",
          },
        }),
      ).toEqual({
        _tag: "ReplacementReady",
        generation: {
          baseline: "current\n\nSkills: accepted",
          snapshot: {
            "core/date": { value: "current", baseline: "current" },
            "core/skill-guidance": {
              value: "accepted",
              baseline: "Skills: accepted",
              refresh: "activation",
            },
          },
        },
      })
      expect(activationLoads).toBe(0)
    }),
  )

  it.effect("retains admitted activation state while the fresh catalog is degraded", () =>
    Effect.gen(function* () {
      const context = stringContext({
        key: "core/skill-guidance",
        value: "degraded",
        refresh: "activation",
        preservePrevious: (value) => value === "degraded",
      })
      const previous = {
        "core/skill-guidance": { value: "accepted", baseline: "accepted", refresh: "activation" as const },
      }

      expect(yield* SystemContext.reconcileActivation(context, previous)).toEqual({ _tag: "Unchanged" })
      expect((yield* SystemContext.initialize(context)).snapshot["core/skill-guidance"]).toEqual({
        value: "degraded",
        baseline: "degraded",
        refresh: "activation",
      })
    }),
  )

  it.effect("uses the baseline for a newly added source", () =>
    Effect.gen(function* () {
      const context = stringContext({
        key: "core/skills",
        value: "effect",
        baseline: (skill) => `Available skill: ${skill}`,
      })

      expect(yield* SystemContext.reconcile(context, {})).toEqual({
        _tag: "Updated",
        text: "Available skill: effect",
        snapshot: { "core/skills": { value: "effect", baseline: "Available skill: effect" } },
      })
    }),
  )

  it.effect("retains admitted snapshots while a source is temporarily unavailable", () =>
    Effect.gen(function* () {
      const previous = { "core/remote": { value: "instructions", removed: "Instructions removed" } }
      const context = stringContext({ key: "core/remote", value: SystemContext.unavailable })

      expect(yield* SystemContext.reconcile(context, previous)).toEqual({ _tag: "Unchanged" })
      expect(yield* SystemContext.replace(context, previous)).toEqual({ _tag: "ReplacementBlocked" })
      expect(yield* SystemContext.replace(context, {})).toMatchObject({ _tag: "ReplacementReady" })
    }),
  )

  it.effect("rebuilds a compaction baseline from admitted values without loading sources", () =>
    Effect.gen(function* () {
      let loads = 0
      const context = SystemContext.combine([
        SystemContext.make({
          key: key("core/date"),
          codec: Schema.toCodecJson(Schema.String),
          load: Effect.sync(() => {
            loads++
            return "new"
          }),
          baseline: (value) => `Date: ${value}`,
          update: (_previous, value) => `Date: ${value}`,
        }),
      ])

      expect(
        SystemContext.rebaseline(context, {
          "core/date": { value: "accepted", baseline: "Date: accepted" },
        }),
      ).toEqual({
        _tag: "ReplacementReady",
        generation: {
          baseline: "Date: accepted",
          snapshot: { "core/date": { value: "accepted", baseline: "Date: accepted" } },
        },
      })
      expect(loads).toBe(0)
    }),
  )

  it.effect("blocks initialization while a source is unavailable", () =>
    Effect.gen(function* () {
      const exit = yield* SystemContext.initialize(
        stringContext({ key: "core/remote", value: SystemContext.unavailable }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit))
        expect(Cause.squash(exit.cause)).toEqual(
          new SystemContext.InitializationBlocked({ keys: [key("core/remote")] }),
        )
    }),
  )

  it.effect("emits the previously stored removal message", () =>
    Effect.gen(function* () {
      expect(
        yield* SystemContext.reconcile(SystemContext.empty, {
          "core/instructions": { value: "contents", removed: "Instructions removed; stop applying them." },
        }),
      ).toEqual({
        _tag: "Updated",
        text: "Instructions removed; stop applying them.",
        snapshot: {},
      })
    }),
  )

  it.effect("requests replacement when a source without removal text disappears", () =>
    Effect.gen(function* () {
      expect(
        yield* SystemContext.reconcile(SystemContext.empty, { "core/date": { value: "2026-06-04" } }),
      ).toMatchObject({
        _tag: "ReplacementReady",
      })
    }),
  )

  it.effect("renders multiple removals in stable key order", () =>
    Effect.gen(function* () {
      expect(
        yield* SystemContext.reconcile(SystemContext.empty, {
          "core/z": { value: "z", removed: "Removed z" },
          "core/a": { value: "a", removed: "Removed a" },
        }),
      ).toMatchObject({ _tag: "Updated", text: "Removed a\n\nRemoved z" })
    }),
  )

  it.effect("rejects empty model-visible renderings", () =>
    Effect.gen(function* () {
      const exit = yield* SystemContext.initialize(
        stringContext({ key: "core/empty", value: "value", baseline: () => "" }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      if (Exit.isFailure(exit)) expect(Cause.pretty(exit.cause)).toContain("rendered an empty baseline")
    }),
  )

  it.effect("requests replacement when a stored value no longer decodes", () =>
    Effect.gen(function* () {
      expect(
        yield* SystemContext.reconcile(stringContext({ key: "core/date", value: "2026-06-04" }), {
          "core/date": { value: 42, removed: "Date removed" },
        }),
      ).toMatchObject({ _tag: "ReplacementReady" })
    }),
  )

  it.effect("replaces from one coherent source observation", () =>
    Effect.gen(function* () {
      let loads = 0
      const context = SystemContext.make({
        key: key("core/date"),
        codec: Schema.toCodecJson(Schema.String),
        load: Effect.sync(() => {
          loads++
          return "2026-06-04"
        }),
        baseline: String,
        update: (_previous, current) => current,
      })

      expect(yield* SystemContext.reconcile(context, { "core/date": { value: 42 } })).toMatchObject({
        _tag: "ReplacementReady",
        generation: { baseline: "2026-06-04" },
      })
      expect(loads).toBe(1)
    }),
  )

  it.effect("does not render discarded updates while replacing", () =>
    Effect.gen(function* () {
      let updates = 0
      const context = SystemContext.combine([
        stringContext({
          key: "core/date",
          value: "2026-06-04",
          update: () => {
            updates++
            return "updated"
          },
        }),
        stringContext({ key: "core/location", value: "/repo" }),
      ])

      expect(
        yield* SystemContext.reconcile(context, {
          "core/date": { value: "2026-06-03" },
          "core/location": { value: 42 },
        }),
      ).toMatchObject({ _tag: "ReplacementReady" })
      expect(updates).toBe(0)
    }),
  )

  it.effect("blocks an incompatible replacement while another admitted source is unavailable", () =>
    Effect.gen(function* () {
      const previous = {
        "core/date": { value: 42, removed: "Date removed" },
        "core/remote": { value: "instructions", removed: "Instructions removed" },
      }
      const context = SystemContext.combine([
        stringContext({ key: "core/date", value: "2026-06-04" }),
        stringContext({ key: "core/remote", value: SystemContext.unavailable }),
      ])

      expect(yield* SystemContext.reconcile(context, previous)).toEqual({ _tag: "ReplacementBlocked" })
      expect(yield* SystemContext.replace(context, previous)).toEqual({ _tag: "ReplacementBlocked" })
    }),
  )

  it.effect("rejects duplicate source keys", () =>
    Effect.sync(() => {
      expect(() =>
        SystemContext.combine([
          stringContext({ key: "core/date", value: "one" }),
          stringContext({ key: "core/date", value: "two" }),
        ]),
      ).toThrow(new SystemContext.DuplicateKeyError({ key: key("core/date") }))
    }),
  )

  it.effect("combines contexts in order", () =>
    Effect.gen(function* () {
      expect(
        (yield* SystemContext.initialize(
          SystemContext.combine([
            stringContext({ key: "core/date", value: "date" }),
            stringContext({ key: "core/location", value: "location" }),
          ]),
        )).baseline,
      ).toBe("date\n\nlocation")
    }),
  )

  it.effect("requires namespaced source keys", () =>
    Effect.sync(() => {
      const decodeKey = Schema.decodeUnknownSync(SystemContext.Key)

      expect(decodeKey("core/date")).toBe(key("core/date"))
      expect(() => decodeKey("date")).toThrow()
    }),
  )

  it.effect("requires namespaced durable snapshot keys", () =>
    Effect.sync(() => {
      const decodeSnapshot = Schema.decodeUnknownSync(SystemContext.Snapshot)

      expect(Object.keys(decodeSnapshot({ "core/date": { value: "date" } }))).toEqual(["core/date"])
      expect(() => decodeSnapshot({ date: { value: "date" } })).toThrow()
      expect(() => decodeSnapshot({ "core/date": { value: "date", removed: "" } })).toThrow()
    }),
  )
})
