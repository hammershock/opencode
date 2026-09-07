export * as ConfigCommand from "./command"

import path from "path"
import { Cause, Exit, Schema } from "effect"
import { Glob } from "@opencode-ai/core/util/glob"
import { ConfigCommandV1 } from "@opencode-ai/core/v1/config/command"
import { configEntryNameFromPath } from "./entry-name"
import { InvalidError } from "@opencode-ai/core/v1/config/error"
import * as ConfigMarkdown from "./markdown"
import fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

const decodeInfo = Schema.decodeUnknownExit(ConfigCommandV1.Info)

// These byte-for-byte templates were installed by the archived opencode-rexd
// packaging script. Matching the complete document prevents a user-authored
// command with the same name from being mistaken for a generated shim.
const legacy = {
  cd: `---\ndescription: Change the active working directory\n---\n\n__LOCAL_CD_COMMAND__ $ARGUMENTS\n`,
  delete: `---\ndescription: Delete the current session and return to the session list\n---\n\n__OPENCODE_REXD_DELETE__\n`,
  devices: `---\ndescription: Manage cloud sync devices and target names\n---\n\n__OPENCODE_REXD_DEVICES__\n`,
  env: `---\ndescription: Inspect, reload, or initialize the project environment\n---\n\nUse \`/env status\` to inspect the effective target environment, \`/env reload\` to reload the current Project root \`.env\`, or \`/env init\` to ask the Agent to create or update \`.env\` from repository evidence.\n`,
  permissions: `---\ndescription: Change permission approval mode\n---\n\n__LOCAL_PERMISSIONS_COMMAND__\n`,
  sync: `---\ndescription: Configure and manage cloud session sync\n---\n\n__OPENCODE_REXD_SYNC__ $ARGUMENTS\n`,
  target: `---\ndescription: Manage REXD remote targets\n---\n\n__REXD_TARGET__ $ARGUMENTS\n`,
} as const

export type LegacyRetirement = { readonly source: string; readonly backup?: string; readonly error?: unknown }

export async function retireLegacy(dir: string): Promise<LegacyRetirement[]> {
  const commandDir = path.join(dir, "commands")
  const results: LegacyRetirement[] = []
  for (const [name, signature] of Object.entries(legacy)) {
    const source = path.join(commandDir, `${name}.md`)
    const stat = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") results.push({ source, error })
      return undefined
    })
    if (!stat?.isFile() || stat.size > 512) continue
    const content = await fs.readFile(source, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      results.push({ source, error })
      return undefined
    })
    if (content === undefined || normalizeLines(content) !== signature) continue
    const backup = `${source}.${Date.now()}.${randomUUID()}.disabled.bak`
    await fs.rename(source, backup).then(
      () => results.push({ source, backup }),
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") results.push({ source, error })
      },
    )
  }
  return results
}

function normalizeLines(input: string) {
  return input.replaceAll("\r\n", "\n")
}

export async function load(dir: string) {
  const result: Record<string, ConfigCommandV1.Info> = {}
  for (const item of await Glob.scan("{command,commands}/**/*.md", {
    cwd: dir,
    absolute: true,
    dot: true,
    symlink: true,
  })) {
    const md = await ConfigMarkdown.parse(item).catch(() => undefined)
    if (!md) continue

    const name = configEntryNameFromPath(path.relative(dir, item), ["command/", "commands/"])

    const config = {
      name,
      ...md.data,
      template: md.content.trim(),
    }
    const parsed = decodeInfo(config, { errors: "all", propertyOrder: "original" })
    if (Exit.isSuccess(parsed)) {
      result[config.name] = parsed.value
      continue
    }
    throw new InvalidError({ path: item, message: Cause.pretty(parsed.cause) }, { cause: Cause.squash(parsed.cause) })
  }
  return result
}
