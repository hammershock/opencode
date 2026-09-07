import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import path from "path"
import { createMemo, Match, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination, type HomeSessionTarget } from "../../routes/home/session-destination"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { DialogLocationDirectory } from "../../component/dialog-location-directory"
import { DialogPrompt } from "../../ui/dialog-prompt"
import { DialogConfirm } from "../../ui/dialog-confirm"
import type { TargetDefinition } from "../../component/target-wizard"
import { TargetHealth, useTargetManager } from "../../component/target-manager"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const targetManager = useTargetManager()
  const targets = targetManager.targets
  const dir = createMemo(() => {
    const selected = destination?.destination()
    if (!selected || selected.type === "new") return
    const target = destination?.target()
    const out = target?.type === "local" ? abbreviateHome(selected.directory, paths.home) : selected.directory
    const branch =
      target?.type === "local" && selected.directory === (props.api.state.path.directory || paths.cwd)
        ? props.api.state.vcs?.branch
        : undefined
    if (branch) return out + ":" + branch
    return out
  })

  const openDirectory = () => {
    if (!destination) return
    const selected = destination.destination()
    if (!selected || selected.type !== "directory") return
    const initial = selected.directory
    dialog.replace(() => (
      <DialogLocationDirectory
        target={destination.target()}
        initial={initial}
        onSelect={(directory) => {
          destination.setDestination({ type: "directory", directory, subdirectory: false })
          dialog.clear()
        }}
      />
    ))
  }

  const preflightDirectory = async (target: HomeSessionTarget, directory: string, workspaceRoots: string[]) => {
    if (!path.isAbsolute(directory)) throw new Error("Working directory must be absolute")
    const normalized = path.normalize(directory)
    const anchor = workspaceRoots
      .map((root) => path.normalize(root))
      .filter((root) => normalized === root || normalized.startsWith(root.endsWith(path.sep) ? root : root + path.sep))
      .sort((a, b) => b.length - a.length)[0]
    if (!anchor) throw new Error("Working directory is outside the configured workspace roots")
    const location = {
      directory: anchor,
      ...(target.type === "rexd" ? { target: target.targetID } : {}),
    }
    const relative = path.relative(anchor, normalized) || "."
    const checked = await sdk.client.v2.fs.directoryStatus({ location, path: relative }, { throwOnError: true })
    if (checked.data.data.status === "directory") return checked.data.data.path
    if (checked.data.data.status === "not-directory") throw new Error("The selected path is not a directory")
    const create = await DialogConfirm.show(
      dialog,
      "Create working directory?",
      `${normalized} does not exist. Create it now?`,
    )
    if (!create) return
    const created = await sdk.client.v2.fs.ensureDirectory({ location, path: relative }, { throwOnError: true })
    return created.data.data.path
  }

  const chooseLocal = () => {
    void (async () => {
      const starting = paths.cwd
      const directory = await DialogPrompt.show(dialog, "local working directory", {
        value: starting,
        placeholder: starting,
        description: () => <text>Absolute local directory used by the new Session. Press Tab to complete paths.</text>,
        complete: async (value, cursor) => {
          const prefix = value.slice(0, cursor)
          const expanded =
            prefix === "~" ? paths.home : prefix.startsWith("~/") ? path.join(paths.home, prefix.slice(2)) : prefix
          const absolute = path.isAbsolute(expanded) ? expanded : path.join(starting, expanded)
          const parent = absolute.endsWith(path.sep) ? absolute : path.dirname(absolute)
          const fragment = absolute.endsWith(path.sep) ? "" : path.basename(absolute)
          const result = await sdk.client.v2.fs.list(
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
          if (!completion) return { value, cursor, candidates }
          return { value: completion + value.slice(cursor), cursor: completion.length, candidates }
        },
      })
      if (!directory?.trim()) return
      const selected = await preflightDirectory({ type: "local" }, directory.trim(), [
        path.parse(directory.trim()).root,
      ])
      if (!selected) return
      destination?.setTarget({ type: "local" })
      destination?.setDestination({ type: "directory", directory: selected, subdirectory: false })
      dialog.clear()
    })().catch((error) =>
      toast.show({ title: "Cannot select local directory", message: errorMessage(error), variant: "error" }),
    )
  }

  const choose = (target: TargetDefinition) => {
    void (async () => {
      try {
        const result = await sdk.client.v2.target.prepare({ targetID: target.id }, { throwOnError: true })
        if (result.data.status !== "ready") throw new Error(`${result.data.stage}: ${result.data.message}`)
        const input = {
          name: target.name,
          connection: target.connection,
          workspaceRoots: target.workspaceRoots,
          transport: target.transport,
          ...(target.defaultDirectory ? { defaultDirectory: target.defaultDirectory } : {}),
          ...(target.command ? { command: target.command } : {}),
        }
        const inspected = await sdk.client.v2.target.wizard.inspect({ input }, { throwOnError: true })
        const starting = inspected.data.home
        const directory = await DialogPrompt.show(dialog, `${target.name} working directory`, {
          value: starting,
          placeholder: starting,
          description: () => (
            <text>Absolute remote directory used by the new Session. Press Tab to complete paths.</text>
          ),
          complete: async (value, cursor) => {
            const completed = await sdk.client.v2.target.wizard.complete(
              { input, value, cursor, cwd: starting },
              { throwOnError: true },
            )
            return { ...completed.data, cursor: Number(completed.data.cursor) }
          },
        })
        if (!directory?.trim()) return
        const selected = { type: "rexd" as const, targetID: target.id, name: target.name }
        const validated = await preflightDirectory(selected, directory.trim(), target.workspaceRoots)
        if (!validated) return
        destination?.setTarget(selected)
        destination?.setDestination({ type: "directory", directory: validated, subdirectory: false })
        dialog.clear()
      } catch (error) {
        toast.show({ title: "Target unavailable", message: errorMessage(error), variant: "error" })
      }
    })()
  }

  const openTargets = () => {
    void targetManager.refreshHealth()
    dialog.replace(() => (
      <DialogSelect
        title="Execution target"
        locked={targets.loading}
        options={[
          { title: "local", description: paths.cwd, value: "local" as const, category: "Targets" },
          ...(targets()?.targets ?? []).map((target) => ({
            title: target.name,
            description: target.defaultDirectory ?? target.workspaceRoots[0],
            footer: <TargetHealth state={targetManager.state(target.id)} />,
            details: [targetManager.detail(target.id)].filter((item): item is string => Boolean(item)),
            value: target as TargetDefinition | "local" | "manage",
            category: "Targets",
          })),
          { title: "Manage targets…", value: "manage" as const, category: "Actions" },
        ]}
        onSelect={(option) => {
          if (option.value === "manage") return targetManager.open()
          if (option.value === "local") return chooseLocal()
          choose(option.value)
        }}
      />
    ))
  }

  return (
    <box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
      <text fg={theme().textMuted} onMouseUp={openTargets} flexShrink={0}>
        {destination?.target().type === "rexd"
          ? (destination.target() as Extract<HomeSessionTarget, { type: "rexd" }>).name
          : "local"}
      </text>
      <text fg={theme().textMuted}>·</text>
      <Show when={dir()}>
        {(value) => (
          <text fg={theme().textMuted} onMouseUp={openDirectory}>
            {value()}
          </text>
        )}
      </Show>
    </box>
  )
}

function Mcp(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const list = createMemo(() => props.api.state.mcp())
  const has = createMemo(() => list().length > 0)
  const err = createMemo(() => list().some((item) => item.status === "failed"))
  const count = createMemo(() => list().filter((item) => item.status === "connected").length)

  return (
    <Show when={has()}>
      <box gap={1} flexDirection="row" flexShrink={0}>
        <text fg={theme().text}>
          <Switch>
            <Match when={err()}>
              <span style={{ fg: theme().error }}>⊙ </span>
            </Match>
            <Match when={true}>
              <span style={{ fg: count() > 0 ? theme().success : theme().textMuted }}>⊙ </span>
            </Match>
          </Switch>
          {count()} MCP
        </text>
        <text fg={theme().textMuted}>/status</text>
      </box>
    </Show>
  )
}

function Version(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  return (
    <box flexShrink={0}>
      <text fg={theme().textMuted}>{props.api.app.version}</text>
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  return (
    <box
      width="100%"
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
      flexDirection="row"
      flexShrink={0}
      gap={2}
    >
      <Directory api={props.api} />
      <Mcp api={props.api} />
      <box flexGrow={1} />
      <Version api={props.api} />
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 100,
    slots: {
      home_footer() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
