import path from "path"
import type { DialogContext } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import type { useSDK } from "../context/sdk"
import type { HomeSessionTarget } from "../routes/home/session-destination"
import type { TargetDefinition, TargetInput } from "./target-wizard"

type SDK = ReturnType<typeof useSDK>

export function targetInput(target: TargetDefinition): TargetInput {
  return {
    name: target.name,
    connection: target.connection,
    workspaceRoots: target.workspaceRoots,
    transport: target.transport,
    ...(target.defaultDirectory ? { defaultDirectory: target.defaultDirectory } : {}),
    ...(target.command ? { command: target.command } : {}),
  }
}

export function targetWizardServices(sdk: SDK) {
  return {
    inspect: (input: TargetInput) =>
      sdk.client.v2.target.wizard
        .inspect({ input }, { throwOnError: true })
        .then((result) => result.data)
        .catch(() => undefined),
    complete: (input: TargetInput, value: string, cursor: number, cwd: string) =>
      sdk.client.v2.target.wizard
        .complete({ input, value, cursor, cwd }, { throwOnError: true })
        .then((result) => ({ ...result.data, cursor: Number(result.data.cursor) }))
        .catch(() => undefined),
  }
}

export async function completeLocalDirectory(input: {
  sdk: SDK
  home: string
  value: string
  cursor: number
  cwd: string
}) {
  const prefix = input.value.slice(0, input.cursor)
  const expanded =
    prefix === "~" ? input.home : prefix.startsWith("~/") ? path.join(input.home, prefix.slice(2)) : prefix
  const absolute = path.isAbsolute(expanded) ? expanded : path.join(input.cwd, expanded)
  const parent = absolute.endsWith(path.sep) ? absolute : path.dirname(absolute)
  const fragment = absolute.endsWith(path.sep) ? "" : path.basename(absolute)
  const result = await input.sdk.client.v2.fs.list(
    { location: { directory: parent }, path: "." },
    { throwOnError: true },
  )
  const candidates = result.data.data
    .filter((entry) => entry.type === "directory" && path.basename(entry.path).startsWith(fragment))
    .map((entry) => path.join(parent, path.basename(entry.path)) + path.sep)
    .sort()
  const completion = candidates.slice(1).reduce((common, candidate) => {
    let index = 0
    while (index < common.length && common[index] === candidate[index]) index++
    return common.slice(0, index)
  }, candidates[0] ?? "")
  if (!completion) return { value: input.value, cursor: input.cursor, candidates }
  return { value: completion + input.value.slice(input.cursor), cursor: completion.length, candidates }
}

export async function preflightDirectory(input: {
  dialog: DialogContext
  sdk: SDK
  target: HomeSessionTarget
  directory: string
  workspaceRoots: readonly string[]
}) {
  if (!path.isAbsolute(input.directory)) throw new Error("Working directory must be absolute")
  const normalized = path.normalize(input.directory)
  const anchor = input.workspaceRoots
    .map((root) => path.normalize(root))
    .filter((root) => normalized === root || normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
    .sort((a, b) => b.length - a.length)[0]
  if (!anchor) throw new Error("Working directory is outside the configured workspace roots")
  const location = {
    directory: anchor,
    ...(input.target.type === "rexd" ? { target: input.target.targetID } : {}),
  }
  const relative = path.relative(anchor, normalized) || "."
  const checked = await input.sdk.client.v2.fs.directoryStatus({ location, path: relative }, { throwOnError: true })
  if (checked.data.data.status === "directory") return checked.data.data.path
  if (checked.data.data.status === "not-directory") throw new Error("The selected path is not a directory")
  const create = await DialogConfirm.show(
    input.dialog,
    "Create working directory?",
    `${normalized} does not exist. Create it now?`,
  )
  if (!create) return
  const created = await input.sdk.client.v2.fs.ensureDirectory({ location, path: relative }, { throwOnError: true })
  return created.data.data.path
}

export async function promptLocationDirectory(input: {
  dialog: DialogContext
  sdk: SDK
  target: HomeSessionTarget
  current: string
  localHome: string
  definition?: TargetDefinition
}) {
  const remote = input.target.type === "rexd"
  if (remote && !input.definition) throw new Error("The selected target is not configured")
  const directory = await DialogPrompt.show(
    input.dialog,
    input.target.type === "rexd" ? `${input.target.name} working directory` : "local working directory",
    {
      value: input.current,
      placeholder: input.current,
      description: () => <text>Absolute {remote ? "remote" : "local"} directory. Press Tab to complete paths.</text>,
      complete: remote
        ? async (value, cursor) => {
            const completed = await input.sdk.client.v2.target.wizard.complete(
              {
                input: targetInput(input.definition!),
                value,
                cursor,
                cwd: input.current,
              },
              { throwOnError: true },
            )
            return { ...completed.data, cursor: Number(completed.data.cursor) }
          }
        : (value, cursor) =>
            completeLocalDirectory({
              sdk: input.sdk,
              home: input.localHome,
              value,
              cursor,
              cwd: input.current,
            }),
    },
  )
  if (!directory?.trim()) return
  return preflightDirectory({
    dialog: input.dialog,
    sdk: input.sdk,
    target: input.target,
    directory: directory.trim(),
    workspaceRoots: remote ? input.definition!.workspaceRoots : [path.parse(directory.trim()).root],
  })
}
