export * as SessionRunCoordinator from "./run-coordinator"

import { Deferred, Effect, Exit, Fiber, FiberSet, Scope } from "effect"

/** Serializes execution for each key while allowing different keys to run concurrently. */
export interface Coordinator<Key, E> {
  /** Snapshots keys with an execution owned by this coordinator. */
  readonly active: Effect.Effect<ReadonlySet<Key>>
  /** Starts execution while idle or joins the active execution. */
  readonly run: (key: Key) => Effect.Effect<void, E>
  /** Registers one coalesced follow-up after newly recorded work. */
  readonly wake: (key: Key) => Effect.Effect<void>
  /** Registers work and waits for the execution generation guaranteed to observe that wake. */
  readonly wakeAndWait: (key: Key) => Effect.Effect<void, E>
  /** Stops active execution and waits for its cleanup. */
  readonly interrupt: (key: Key) => Effect.Effect<void>
}

type Entry<E> = {
  readonly done: Deferred.Deferred<void, E>
  wakeDone?: Deferred.Deferred<void, E>
  owner?: Fiber.Fiber<void>
  pendingWake: boolean
  stopping: boolean
}

export const make = <Key, E>(options: {
  readonly drain: (key: Key, force: boolean) => Effect.Effect<void, E>
  /** Test/diagnostic observation only; callback failures never affect execution. */
  readonly onAdmission?: (event: { readonly key: Key; readonly type: "started" | "joined" }) => void
}): Effect.Effect<Coordinator<Key, E>, never, Scope.Scope> =>
  Effect.gen(function* () {
    const active = new Map<Key, Entry<E>>()
    const fork = yield* FiberSet.makeRuntime<never, void, never>()

    const makeEntry = (): Entry<E> => ({
      done: Deferred.makeUnsafe<void, E>(),
      pendingWake: false,
      stopping: false,
    })
    const observe = (key: Key, type: "started" | "joined") => {
      try {
        options.onAdmission?.({ key, type })
      } catch {
        // Admission observation must not alter coordinator semantics.
      }
    }

    const start = (key: Key, entry: Entry<E>, force: boolean, successor = false) => {
      const ready = Deferred.makeUnsafe<void>()
      const owner = fork(
        (successor ? Effect.yieldNow : Deferred.await(ready)).pipe(
          Effect.andThen(Effect.suspend(() => options.drain(key, force))),
          Effect.onExit((exit) => Effect.sync(() => settle(key, entry, exit))),
          Effect.exit,
          Effect.asVoid,
        ),
      )
      entry.owner = owner
      if (!successor) Deferred.doneUnsafe(ready, Effect.void)
    }

    const settle = (key: Key, entry: Entry<E>, exit: Exit.Exit<void, E>) => {
      if (Exit.isSuccess(exit) && !entry.stopping && entry.pendingWake) {
        entry.pendingWake = false
        start(key, entry, false, true)
        return
      }

      const successor = entry.pendingWake ? makeEntry() : undefined
      if (successor === undefined) active.delete(key)
      else {
        successor.wakeDone = entry.wakeDone
        active.set(key, successor)
        start(key, successor, false, true)
      }
      Deferred.doneUnsafe(entry.done, exit)
      if (successor === undefined && entry.wakeDone !== undefined) Deferred.doneUnsafe(entry.wakeDone, exit)
    }

    const run = (key: Key): Effect.Effect<void, E> =>
      Effect.uninterruptibleMask((restore) => {
        const entry = active.get(key)
        if (entry !== undefined) {
          observe(key, "joined")
          if (entry.stopping) return restore(Deferred.await(entry.done).pipe(Effect.andThen(run(key))))
          return restore(Deferred.await(entry.done))
        }

        const next = makeEntry()
        active.set(key, next)
        observe(key, "started")
        start(key, next, true)
        return restore(Deferred.await(next.done))
      })

    const scheduleWake = (key: Key) =>
      Effect.sync(() => {
        const entry = active.get(key)
        if (entry !== undefined) {
          entry.pendingWake = true
          entry.wakeDone ??= Deferred.makeUnsafe<void, E>()
          return entry.wakeDone
        }

        const next = makeEntry()
        next.wakeDone = Deferred.makeUnsafe<void, E>()
        active.set(key, next)
        start(key, next, false)
        return next.wakeDone
      })

    const wake = (key: Key) => scheduleWake(key).pipe(Effect.asVoid)
    const wakeAndWait = (key: Key) => scheduleWake(key).pipe(Effect.flatMap(Deferred.await))

    const interrupt = (key: Key): Effect.Effect<void> =>
      Effect.suspend(() => {
        const entry = active.get(key)
        if (entry?.owner === undefined) return Effect.void
        entry.stopping = true
        entry.pendingWake = false
        return Fiber.interrupt(entry.owner)
      })

    return { active: Effect.sync(() => new Set(active.keys())), run, wake, wakeAndWait, interrupt }
  })
