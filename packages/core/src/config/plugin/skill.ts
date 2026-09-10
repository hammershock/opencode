export * as ConfigSkillPlugin from "./skill"

import { define } from "../../plugin/internal"
import path from "path"
import { Effect } from "effect"
import { Config } from "../../config"
import { AbsolutePath } from "../../schema"
import { SkillV2 } from "../../skill"
import { Global } from "../../global"
import { Location } from "../../location"
import { SkillSettings } from "../../skill/settings"

export const Plugin = define({
  id: "config-skill",
  effect: Effect.fn(function* () {
    const config = yield* Config.Service
    const global = yield* Global.Service
    const location = yield* Location.Service
    const skill = yield* SkillV2.Service
    const settings = yield* SkillSettings.Service
    yield* skill.transform(
      Effect.fn(function* (draft) {
        const entries = yield* config.entries()
        const configured = yield* Effect.promise(() => settings.load())
        draft.target(location.target.type === "local" ? "local" : location.target.targetID)
        const directories = entries.flatMap((entry) => {
          if (entry.type !== "directory") return []
          const globalDirectory = path.resolve(entry.path) === path.resolve(global.config)
          if (globalDirectory || location.target.type !== "local") return []
          return [{ path: entry.path, kind: "opencode-project" as const }]
        })
        const items = entries.flatMap((entry) => {
          if (entry.type !== "document") return []
          if (entry.scope === "global" || location.target.type !== "local") return []
          if (!entry.info.skills) return []
          if (Array.isArray(entry.info.skills))
            return (entry.info.skills as readonly string[]).map((value) => ({ value, path: entry.path }))
          const skills = entry.info.skills as Exclude<typeof entry.info.skills, readonly string[]>
          if (skills.targets)
            draft.diagnostic({
              kind: "project-target-scope-ignored",
              severity: "warning",
              sourceLabel: "Project config",
              message: "Project Skill target scopes are ignored because target IDs are device-local",
            })
          return [...(skills.paths ?? []), ...(skills.urls ?? [])].map((value) => ({
            value,
            path: entry.path,
          }))
        })
        for (const root of configured.roots) {
          if (root.kind === "url") {
            draft.source(SkillV2.UrlSource.make({ type: "url", url: root.value }))
            continue
          }
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(root.resolved ?? root.value),
            }),
            { kind: root.kind },
          )
        }
        for (const directory of directories) {
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(directory.path, "skill")),
            }),
            { kind: directory.kind },
          )
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(path.join(directory.path, "skills")),
            }),
            { kind: directory.kind },
          )
        }
        for (const item of items) {
          if (URL.canParse(item.value) && /^(https?:)$/.test(new URL(item.value).protocol)) {
            draft.source(SkillV2.UrlSource.make({ type: "url", url: item.value }))
            continue
          }
          const expanded = item.value.startsWith("~/") ? path.join(global.home, item.value.slice(2)) : item.value
          draft.source(
            SkillV2.DirectorySource.make({
              type: "directory",
              path: AbsolutePath.make(
                path.isAbsolute(expanded)
                  ? expanded
                  : path.resolve(item.path ? path.dirname(item.path) : location.directory, expanded),
              ),
            }),
            { kind: "imported" },
          )
        }
      }),
    )
  }),
})
