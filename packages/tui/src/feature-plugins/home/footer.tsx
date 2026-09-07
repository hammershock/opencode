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
import { DialogPrompt } from "../../ui/dialog-prompt"
import type { TargetDefinition } from "../../component/target-wizard"
import { TargetHealth, useTargetManager } from "../../component/target-manager"
import {
  completeLocalDirectory,
  preflightDirectory as preflightLocationDirectory,
  targetInput,
} from "../../component/location-directory-workflow"

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

  const completeLocal = async (value: string, cursor: number, cwd: string) => {
    return completeLocalDirectory({ sdk, home: paths.home, value, cursor, cwd })
  }

  const preflightDirectory = async (target: HomeSessionTarget, directory: string, workspaceRoots: string[]) => {
    return preflightLocationDirectory({ dialog, sdk, target, directory, workspaceRoots })
  }

  const openDirectory = () => {
    if (!destination) return
    const current = destination.destination()
    if (!current || current.type !== "directory") return
    void (async () => {
      const target = destination.target()
      if (target.type === "local") {
        const directory = await DialogPrompt.show(dialog, "local working directory", {
          value: current.directory,
          placeholder: current.directory,
          description: () => (
            <text>Absolute local directory used by the new Session. Press Tab to complete paths.</text>
          ),
          complete: (value, cursor) => completeLocal(value, cursor, current.directory),
        })
        if (!directory?.trim()) return
        const validated = await preflightDirectory(target, directory.trim(), [path.parse(directory.trim()).root])
        if (!validated) return
        destination.setDestination({ type: "directory", directory: validated, subdirectory: false })
        return dialog.clear()
      }
      const configured = targets()?.targets.find((item) => item.id === target.targetID) as TargetDefinition | undefined
      if (!configured) throw new Error(`Target ${target.name} is no longer configured`)
      const input = targetInput(configured)
      const directory = await DialogPrompt.show(dialog, `${target.name} working directory`, {
        value: current.directory,
        placeholder: current.directory,
        description: () => <text>Absolute remote directory used by the new Session. Press Tab to complete paths.</text>,
        complete: async (value, cursor) => {
          const completed = await sdk.client.v2.target.wizard.complete(
            { input, value, cursor, cwd: current.directory },
            { throwOnError: true },
          )
          return { ...completed.data, cursor: Number(completed.data.cursor) }
        },
      })
      if (!directory?.trim()) return
      const validated = await preflightDirectory(target, directory.trim(), configured.workspaceRoots)
      if (!validated) return
      destination.setDestination({ type: "directory", directory: validated, subdirectory: false })
      dialog.clear()
    })().catch((error) =>
      toast.show({ title: "Cannot select working directory", message: errorMessage(error), variant: "error" }),
    )
  }

  const chooseLocal = () => {
    void (async () => {
      const starting = paths.cwd
      const directory = await DialogPrompt.show(dialog, "local working directory", {
        value: starting,
        placeholder: starting,
        description: () => <text>Absolute local directory used by the new Session. Press Tab to complete paths.</text>,
        complete: (value, cursor) => completeLocal(value, cursor, starting),
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
        const input = targetInput(target)
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
