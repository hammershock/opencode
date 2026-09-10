import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Global } from "@opencode-ai/core/global"
import { InstructionContext } from "@opencode-ai/core/instruction-context"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SystemContext } from "@opencode-ai/core/system-context"
import { SystemContextRegistry } from "@opencode-ai/core/system-context/registry"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { testEffect } from "./lib/effect"
import { Database } from "@opencode-ai/core/database/database"
import { EventV2 } from "@opencode-ai/core/event"
import { EventTable } from "@opencode-ai/core/event/sql"
import { Project } from "@opencode-ai/core/project"
import { ProjectTable } from "@opencode-ai/core/project/sql"
import { SessionContextEpochTable, SessionTable } from "@opencode-ai/core/session/sql"
import { SessionV2 } from "@opencode-ai/core/session"
import { eq } from "drizzle-orm"
import { Config } from "@opencode-ai/core/config"
import { ControllerFileSystem } from "@opencode-ai/core/controller-filesystem"
import { ModelContext } from "@opencode-ai/schema/model-context"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
  controllerFilesystemLayer?: Layer.Layer<ControllerFileSystem.Service>
  configLayer?: Layer.Layer<Config.Service>
}) =>
  AppNodeBuilder.build(
    LayerNode.group([Database.node, EventV2.node, SystemContextRegistry.node, InstructionContext.node]),
    [
      [Global.node, Global.layerWith({ config: input.config })],
      [Location.node, input.locationServiceLayer],
      ...(input.filesystemLayer ? [[FSUtil.locationNode, input.filesystemLayer] as const] : []),
      ...(input.controllerFilesystemLayer
        ? [[ControllerFileSystem.node, input.controllerFilesystemLayer] as const]
        : []),
      ...(input.configLayer ? [[Config.node, input.configLayer] as const] : []),
    ],
  )

describe("InstructionContext", () => {
  it.live("loads global and upward project AGENTS.md files as one aggregate context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const global = path.join(tmp.path, "global")
          const project = path.join(tmp.path, "project")
          const directory = path.join(project, "packages", "core")
          const outside = path.join(tmp.path, "AGENTS.md")
          const globalFile = path.join(global, "AGENTS.md")
          const projectFile = path.join(project, "AGENTS.md")
          const packageFile = path.join(directory, "AGENTS.md")
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const load = SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )

          const initialized = yield* SystemContext.initialize(yield* load)
          expect(initialized.baseline).toBe(
            [
              "Instructions from: <user-config>/AGENTS.md\nglobal",
              `Instructions from: ${projectFile}\nproject`,
              `Instructions from: ${packageFile}\npackage`,
            ].join("\n\n"),
          )
          expect(initialized.baseline).not.toContain("outside")

          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toEqual({ _tag: "Unchanged" })

          yield* Effect.promise(() => fs.rm(packageFile))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toEqual({ _tag: "Unchanged" })

          yield* Effect.promise(() => Promise.all([fs.rm(globalFile), fs.rm(projectFile)]))
          expect(yield* SystemContext.reconcile(yield* load, initialized.snapshot)).toEqual({ _tag: "Unchanged" })
        }),
      ),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const context = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.provide(
              instructionLayer({
                config: path.join(tmp.path, "global"),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
                ),
              }),
            ),
          )

          const generation = yield* SystemContext.initialize(context)
          expect(generation.baseline).toBe("")
          expect(generation.snapshot["core/instructions"].value).toMatchObject([
            { source: file, status: "loaded", content: "" },
          ])
        }),
      ),
    ),
  )

  it.live("uses CLAUDE.md only when AGENTS.md is absent from the applicable project chain", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "project")
        const directory = path.join(project, "child")
        const rootClaude = path.join(project, "CLAUDE.md")
        const childClaude = path.join(directory, "CLAUDE.md")
        const rootAgents = path.join(project, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(rootClaude, "root claude")
            await fs.writeFile(childClaude, "child claude")
          })
          const load = () =>
            SystemContextRegistry.Service.pipe(
              Effect.flatMap((service) => service.load()),
              Effect.flatMap(SystemContext.initialize),
              Effect.provide(
                instructionLayer({
                  config: global,
                  locationServiceLayer: Layer.succeed(
                    Location.Service,
                    Location.Service.of(
                      location(
                        { directory: AbsolutePath.make(directory) },
                        { projectDirectory: AbsolutePath.make(project) },
                      ),
                    ),
                  ),
                }),
              ),
            )

          expect((yield* load()).baseline).toContain(`Instructions from: ${rootClaude}\nroot claude`)
          expect((yield* load()).baseline).toContain(`Instructions from: ${childClaude}\nchild claude`)
          yield* Effect.promise(() => fs.writeFile(rootAgents, "canonical"))
          const canonical = yield* load()
          expect(canonical.baseline).toContain(`Instructions from: ${rootAgents}\ncanonical`)
          expect(canonical.baseline).not.toContain("root claude")
          expect(canonical.baseline).not.toContain("child claude")
        })
      }),
    ),
  )

  it.effect("resolves configured instruction files on their declaring filesystem in stable scope order", () =>
    Effect.gen(function* () {
      const reads: string[] = []
      const filesystem = (side: "controller" | "target") =>
        FSUtil.Service.of({
          existsSafe: () => Effect.succeed(false),
          readFileStringSafe: (filepath: string) =>
            Effect.sync(() => {
              reads.push(`${side}:${filepath}`)
              return side === "controller" ? "private global" : "remote project"
            }),
          resolve: (filepath: string) => Effect.succeed(filepath),
          up: () => Effect.succeed([]),
          glob: () => Effect.succeed([]),
          globMatch: () => false,
        } as unknown as FSUtil.Interface)
      const documents = [
        new Config.Document({
          type: "document",
          path: "/controller/opencode.json",
          scope: "global",
          filesystem: "controller",
          info: new Config.Info({ instructions: ["rules.md"] }),
        }),
        new Config.Document({
          type: "document",
          path: "/target/opencode.json",
          scope: "project",
          filesystem: "target",
          info: new Config.Info({ instructions: ["rules.md"] }),
        }),
      ]
      const generation = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.flatMap(SystemContext.initialize),
        Effect.provide(
          instructionLayer({
            config: "/controller",
            filesystemLayer: Layer.succeed(FSUtil.Service, filesystem("target")),
            controllerFilesystemLayer: Layer.succeed(
              ControllerFileSystem.Service,
              ControllerFileSystem.Service.of(filesystem("controller")),
            ),
            configLayer: Layer.succeed(Config.Service, Config.Service.of({ entries: () => Effect.succeed(documents) })),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/target") },
                  { projectDirectory: AbsolutePath.make("/target") },
                ),
              ),
            ),
          }),
        ),
      )
      const instructions = generation.snapshot["core/instructions"]?.value as ModelContext.Instructions
      expect(instructions).toMatchObject([
        { scope: "global", source: "<user-config>/rules.md", content: "private global" },
        { scope: "project", source: "/target/rules.md", content: "remote project" },
      ])
      expect(reads).toEqual(["controller:/controller/rules.md", "target:/target/rules.md"])
    }),
  )

  it.live("keeps configured glob and URL results in declaration and lexical order", () =>
    Effect.acquireRelease(
      Effect.sync(() =>
        Bun.serve({
          port: 0,
          fetch: () => new Response("remote URL rules"),
        }),
      ),
      (server) => Effect.sync(() => server.stop(true)),
    ).pipe(
      Effect.flatMap((server) =>
        Effect.gen(function* () {
          const filesystem = (side: "controller" | "target") =>
            FSUtil.Service.of({
              existsSafe: () => Effect.succeed(false),
              readFileStringSafe: (filepath: string) => Effect.succeed(`${side}:${path.basename(filepath)}`),
              resolve: (filepath: string) => Effect.succeed(filepath),
              up: () => Effect.succeed([]),
              glob: () =>
                Effect.succeed(
                  side === "controller"
                    ? [AbsolutePath.make("/controller/z.md"), AbsolutePath.make("/controller/a.md")]
                    : [AbsolutePath.make("/target/z.md"), AbsolutePath.make("/target/a.md")],
                ),
              globMatch: () => false,
            } as unknown as FSUtil.Interface)
          const documents = [
            new Config.Document({
              type: "document",
              path: "/controller/opencode.json",
              scope: "global",
              filesystem: "controller",
              info: new Config.Info({ instructions: ["*.md", server.url.href] }),
            }),
            new Config.Document({
              type: "document",
              path: "/target/opencode.json",
              scope: "project",
              filesystem: "target",
              info: new Config.Info({ instructions: ["*.md"] }),
            }),
          ]
          const generation = yield* SystemContextRegistry.Service.pipe(
            Effect.flatMap((service) => service.load()),
            Effect.flatMap(SystemContext.initialize),
            Effect.provide(
              instructionLayer({
                config: "/controller",
                filesystemLayer: Layer.succeed(FSUtil.Service, filesystem("target")),
                controllerFilesystemLayer: Layer.succeed(
                  ControllerFileSystem.Service,
                  ControllerFileSystem.Service.of(filesystem("controller")),
                ),
                configLayer: Layer.succeed(
                  Config.Service,
                  Config.Service.of({ entries: () => Effect.succeed(documents) }),
                ),
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make("/target") },
                      { projectDirectory: AbsolutePath.make("/target") },
                    ),
                  ),
                ),
              }),
            ),
          )
          const instructions = generation.snapshot["core/instructions"]?.value as ModelContext.Instructions
          expect(instructions.map((item) => [item.scope, item.source, item.content])).toEqual([
            ["global", "<user-config>/a.md", "controller:a.md"],
            ["global", "<user-config>/z.md", "controller:z.md"],
            ["global", server.url.href, "remote URL rules"],
            ["project", "/target/a.md", "target:a.md"],
            ["project", "/target/z.md", "target:z.md"],
          ])
        }),
      ),
    ),
  )

  it.effect("preserves admitted instructions while observation is unavailable", () =>
    Effect.gen(function* () {
      const failingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: failingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: "/repo/AGENTS.md", content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("preserves admitted instructions when a discovered file disappears before read", () =>
    Effect.gen(function* () {
      const file = AbsolutePath.make("/repo/AGENTS.md")
      const racingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: () => Effect.succeed([file]),
              readFileStringSafe: () => Effect.succeed(undefined),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
      const context = yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: racingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )

      expect(
        yield* SystemContext.reconcile(context, {
          "core/instructions": {
            value: [{ path: file, content: "old" }],
            removed: "Previously loaded instructions no longer apply.",
          },
        }),
      ).toEqual({ _tag: "Unchanged" })
    }),
  )

  it.effect("canonicalizes upward discovery boundaries", () =>
    Effect.gen(function* () {
      let observed: { targets: string[]; start: string; stop?: string } | undefined
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) =>
                Effect.sync(() => {
                  observed = options
                  return []
                }),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.flatMap(SystemContext.initialize),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )

      expect(observed).toEqual({
        targets: ["AGENTS.md", "CLAUDE.md", "CONTEXT.md"],
        start: FSUtil.resolve("/repo"),
        stop: FSUtil.resolve("/repo"),
      })
    }),
  )

  it.effect("honors the project instruction opt-out", () =>
    Effect.gen(function* () {
      const previous = process.env.OPENCODE_DISABLE_PROJECT_CONFIG
      let scanned = false
      process.env.OPENCODE_DISABLE_PROJECT_CONFIG = "1"

      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            if (previous === undefined) delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG
            else process.env.OPENCODE_DISABLE_PROJECT_CONFIG = previous
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.effect("does not discover project instructions outside the canonical project root", () =>
    Effect.gen(function* () {
      let scanned = false
      yield* SystemContextRegistry.Service.pipe(
        Effect.flatMap((service) => service.load()),
        Effect.provide(
          instructionLayer({
            config: "/global",
            filesystemLayer: Layer.effect(
              FSUtil.Service,
              FSUtil.Service.pipe(
                Effect.map((fs) => FSUtil.Service.of({ ...fs, up: () => Effect.sync(() => ((scanned = true), [])) })),
              ),
            ).pipe(Layer.provide(LayerNode.compile(FSUtil.node))),
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      expect(scanned).toBe(false)
    }),
  )

  it.live("durably appends nested target instructions before deeper content is consumed", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const project = path.join(tmp.path, "repo")
        const child = path.join(project, "packages", "app")
        const target = path.join(child, "source.ts")
        const projectFile = path.join(project, "AGENTS.md")
        const nestedFile = path.join(child, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(child, { recursive: true })
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(nestedFile, "nested")
            await fs.writeFile(target, "content")
          })

          const sessionID = SessionV2.ID.make("ses_nested_instruction")
          yield* Effect.gen(function* () {
            const { db } = yield* Database.Service
            const registry = yield* SystemContextRegistry.Service
            const instructions = yield* InstructionContext.Service
            const initial = yield* registry.load().pipe(Effect.flatMap(SystemContext.initialize))
            yield* db
              .insert(ProjectTable)
              .values({ id: Project.ID.global, worktree: AbsolutePath.make(project), sandboxes: [] })
              .run()
            yield* db
              .insert(SessionTable)
              .values({
                id: sessionID,
                project_id: Project.ID.global,
                slug: "nested",
                directory: project,
                title: "nested",
                version: "test",
              })
              .run()
            yield* db
              .insert(SessionContextEpochTable)
              .values({
                session_id: sessionID,
                baseline: initial.baseline,
                snapshot: initial.snapshot,
                baseline_seq: 0,
                generation: 1,
                reason: "created",
                location_revision: 0,
                digest: "initial",
              })
              .run()

            yield* instructions.extend({ sessionID, path: target, kind: "file" })
            const event = yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).get()
            expect(event?.type).toBe("session.next.context.advanced.1")
            expect(event?.data).toMatchObject({
              cause: "nested-instructions",
              text: `Instructions from: ${nestedFile}\nnested`,
            })
            if (!event) return yield* Effect.die("ContextAdvanced event missing")
            const sources = (event.data as { sources: SystemContext.Snapshot }).sources
            expect(sources["core/instructions"]?.value).toMatchObject([
              { source: projectFile, origin: "project-file", content: "project" },
              { source: nestedFile, origin: "nested-file", content: "nested" },
            ])

            yield* db
              .update(SessionContextEpochTable)
              .set({ snapshot: sources })
              .where(eq(SessionContextEpochTable.session_id, sessionID))
              .run()
            yield* instructions.extend({ sessionID, path: target, kind: "file" })
            expect(
              yield* db.select().from(EventTable).where(eq(EventTable.aggregate_id, sessionID)).all(),
            ).toHaveLength(1)
          }).pipe(
            Effect.provide(
              instructionLayer({
                config: global,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(project) },
                      {
                        projectDirectory: AbsolutePath.make(project),
                        canonicalDirectory: AbsolutePath.make(project),
                      },
                    ),
                  ),
                ),
              }),
            ),
          )
        })
      }),
    ),
  )
})
