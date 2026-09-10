import path from "path"
import { describe, expect } from "bun:test"
import { Effect, Layer, Schema } from "effect"
import { Config } from "@opencode-ai/core/config"
import { ConfigSkillPlugin } from "@opencode-ai/core/config/plugin/skill"
import { Global } from "@opencode-ai/core/global"
import { Location } from "@opencode-ai/core/location"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { SkillV2 } from "@opencode-ai/core/skill"
import { SkillRegistry } from "@opencode-ai/core/skill/registry"
import { SkillSettings } from "@opencode-ai/core/skill/settings"
import { Skill } from "@opencode-ai/schema/skill"
import { location } from "../fixture/location"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)
const decode = Schema.decodeUnknownSync(Config.Info)

describe("ConfigSkillPlugin.Plugin", () => {
  it.effect("registers configured skill directories and URLs", () =>
    Effect.gen(function* () {
      const directory = AbsolutePath.make("/repo/packages/app")
      const sources: SkillV2.Source[] = []
      const options: Array<SkillRegistry.SourceOptions | undefined> = []
      const diagnostics: Skill.Diagnostic[] = []
      const transform = Effect.fnUntraced(function* (update: (draft: SkillV2.Draft) => void | Effect.Effect<void>) {
        const result = update({
          source: (source, sourceOptions) => {
            sources.push(source)
            options.push(sourceOptions)
          },
          diagnostic: (diagnostic) => diagnostics.push(diagnostic),
          target: () => {},
          list: () => sources,
        })
        if (Effect.isEffect(result)) yield* result
        const dispose = Effect.sync(() => {
          sources.length = 0
          options.length = 0
        })
        yield* Effect.addFinalizer(() => dispose)
        return { dispose }
      })

      yield* ConfigSkillPlugin.Plugin.effect(
        host({
          skill: { transform, reload: () => Effect.void },
        }),
      ).pipe(
        Effect.provideService(
          SkillSettings.Service,
          SkillSettings.Service.of({
            load: async () =>
              Skill.SettingsSnapshot.make({
                path: AbsolutePath.make("/home/test/.config/opencode/opencode.jsonc"),
                revision: Skill.Digest.make("0".repeat(64)),
                roots: [],
                targets: {},
                diagnostics: [],
                valid: true,
              }),
            updateDiscovery: async () => Effect.die("unused") as never,
            resetDiscovery: async () => Effect.die("unused") as never,
            updateTargetScope: async () => Effect.die("unused") as never,
          }),
        ),
        Effect.provideService(
          SkillV2.Service,
          SkillV2.Service.of({
            transform,
            reload: () => Effect.void,
            sources: () => Effect.succeed(sources),
            list: () => Effect.succeed([]),
            catalog: () => Effect.die("unused"),
          }),
        ),
        Effect.provideService(Global.Service, Global.Service.of({ ...Global.make(), home: "/home/test" })),
        Effect.provideService(Location.Service, Location.Service.of(location({ directory }))),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/repo/.opencode") }),
                new Config.Document({
                  type: "document",
                  info: decode({
                    skills: {
                      paths: ["./skills", "~/shared-skills", "/opt/skills"],
                      urls: ["https://example.test/skills/"],
                      targets: { [`skl_${"1".repeat(64)}`]: ["local"] },
                    },
                  }),
                }),
              ]),
          }),
        ),
      )

      expect(sources).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/repo/.opencode", "skills")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(directory, "skills")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join("/home/test", "shared-skills")),
        }),
        SkillV2.DirectorySource.make({ type: "directory", path: AbsolutePath.make("/opt/skills") }),
        SkillV2.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
      ])
      expect(options).toEqual([
        { kind: "opencode-project" },
        { kind: "opencode-project" },
        { kind: "imported" },
        { kind: "imported" },
        { kind: "imported" },
        undefined,
      ])
      expect(diagnostics).toEqual([
        expect.objectContaining({ kind: "project-target-scope-ignored", severity: "warning" }),
      ])
    }),
  )

  it.effect("excludes target project roots for Rexd locations", () =>
    Effect.gen(function* () {
      const sources: SkillV2.Source[] = []
      const options: Array<SkillRegistry.SourceOptions | undefined> = []
      const transform = Effect.fnUntraced(function* (update: (draft: SkillV2.Draft) => void | Effect.Effect<void>) {
        const result = update({
          source: (source, sourceOptions) => {
            sources.push(source)
            options.push(sourceOptions)
          },
          diagnostic: () => {},
          target: () => {},
          list: () => sources,
        })
        if (Effect.isEffect(result)) yield* result
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            sources.length = 0
            options.length = 0
          }),
        )
        return { dispose: Effect.void }
      })
      const global = Global.Service.of({
        ...Global.make(),
        home: "/home/controller",
        config: "/home/controller/.config/opencode",
      })

      yield* ConfigSkillPlugin.Plugin.effect(host({ skill: { transform, reload: () => Effect.void } })).pipe(
        Effect.provideService(
          SkillSettings.Service,
          SkillSettings.Service.of({
            load: async () =>
              Skill.SettingsSnapshot.make({
                path: AbsolutePath.make("/home/controller/.config/opencode/opencode.jsonc"),
                revision: Skill.Digest.make("0".repeat(64)),
                roots: [
                  Skill.DiscoveryRoot.make({
                    kind: "opencode-global",
                    value: "/home/controller/.config/opencode/skill",
                    resolved: AbsolutePath.make("/home/controller/.config/opencode/skill"),
                    default: true,
                    status: "ready",
                  }),
                  Skill.DiscoveryRoot.make({
                    kind: "opencode-global",
                    value: "/home/controller/.config/opencode/skills",
                    resolved: AbsolutePath.make("/home/controller/.config/opencode/skills"),
                    default: true,
                    status: "ready",
                  }),
                  Skill.DiscoveryRoot.make({
                    kind: "imported",
                    value: "/home/controller/shared-skills",
                    resolved: AbsolutePath.make("/home/controller/shared-skills"),
                    default: false,
                    status: "ready",
                  }),
                  Skill.DiscoveryRoot.make({
                    kind: "url",
                    value: "https://example.test/skills/",
                    default: false,
                    status: "configured",
                  }),
                ],
                targets: {},
                diagnostics: [],
                valid: true,
              }),
            updateDiscovery: async () => Effect.die("unused") as never,
            resetDiscovery: async () => Effect.die("unused") as never,
            updateTargetScope: async () => Effect.die("unused") as never,
          }),
        ),
        Effect.provideService(
          SkillV2.Service,
          SkillV2.Service.of({
            transform,
            reload: () => Effect.void,
            sources: () => Effect.succeed(sources),
            list: () => Effect.succeed([]),
            catalog: () => Effect.die("unused"),
          }),
        ),
        Effect.provideService(Global.Service, global),
        Effect.provideService(
          Location.Service,
          Location.Service.of(
            location({
              target: { type: "rexd", targetID: Location.TargetID.make("9872d426-9fc5-4d45-a41f-d737f47d1d8b") },
              directory: AbsolutePath.make("/remote/repo"),
            }),
          ),
        ),
        Effect.provideService(
          Config.Service,
          Config.Service.of({
            entries: () =>
              Effect.succeed([
                new Config.Directory({ type: "directory", path: AbsolutePath.make(global.config) }),
                new Config.Directory({ type: "directory", path: AbsolutePath.make("/remote/repo/.opencode") }),
                new Config.Document({
                  type: "document",
                  scope: "global",
                  filesystem: "controller",
                  info: decode({ skills: ["~/shared-skills", "https://example.test/skills/"] }),
                }),
                new Config.Document({
                  type: "document",
                  scope: "project",
                  filesystem: "target",
                  info: decode({ skills: ["./target-skills"] }),
                }),
              ]),
          }),
        ),
      )

      expect(sources).toEqual([
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(global.config, "skill")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make(path.join(global.config, "skills")),
        }),
        SkillV2.DirectorySource.make({
          type: "directory",
          path: AbsolutePath.make("/home/controller/shared-skills"),
        }),
        SkillV2.UrlSource.make({ type: "url", url: "https://example.test/skills/" }),
      ])
      expect(options).toEqual([
        { kind: "opencode-global" },
        { kind: "opencode-global" },
        { kind: "imported" },
        undefined,
      ])
    }),
  )
})
