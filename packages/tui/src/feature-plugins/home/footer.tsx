import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createMemo, createResource, Match, Show, Switch } from "solid-js"
import { abbreviateHome } from "../../runtime"
import { useTuiPaths } from "../../context/runtime"
import { useHomeSessionDestination, type HomeSessionTarget } from "../../routes/home/session-destination"
import { useDialog } from "../../ui/dialog"
import { DialogSelect } from "../../ui/dialog-select"
import { DialogConfirm } from "../../ui/dialog-confirm"
import { useSDK } from "../../context/sdk"
import { useToast } from "../../ui/toast"
import { errorMessage } from "../../util/error"
import { DialogLocationDirectory } from "../../component/dialog-location-directory"
import { targetWizard, type TargetDefinition } from "../../component/target-wizard"

const id = "internal:home-footer"

function Directory(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  const destination = useHomeSessionDestination()
  const paths = useTuiPaths()
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [targets, targetsControl] = createResource(async () => {
    const result = await sdk.client.v2.target.list({ throwOnError: true })
    return result.data
  })
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

  const choose = (target: TargetDefinition) => {
    void (async () => {
      try {
        const result = await sdk.client.v2.target.prepare({ targetID: target.id }, { throwOnError: true })
        if (result.data.status !== "ready") throw new Error(`${result.data.stage}: ${result.data.message}`)
        const selected = { type: "rexd" as const, targetID: target.id, name: target.name }
        dialog.replace(() => (
          <DialogLocationDirectory
            target={selected}
            initial={target.defaultDirectory ?? target.workspaceRoots[0] ?? "/"}
            onSelect={(directory) => {
              destination?.setTarget(selected)
              destination?.setDestination({ type: "directory", directory, subdirectory: false })
              dialog.clear()
            }}
          />
        ))
      } catch (error) {
        toast.show({ title: "Target unavailable", message: errorMessage(error), variant: "error" })
      }
    })()
  }

  const save = (current?: TargetDefinition) => {
    void (async () => {
      const snapshot = targets()
      if (!snapshot) return
      const input = await targetWizard(dialog, current)
      if (!input) return
      try {
        const result = current
          ? await sdk.client.v2.target.update(
              { targetID: current.id, input, expectedRevision: snapshot.revision },
              { throwOnError: true },
            )
          : await sdk.client.v2.target.create({ input, expectedRevision: snapshot.revision }, { throwOnError: true })
        await targetsControl.refetch()
        const tested = await sdk.client.v2.target.test({ targetID: result.data.target.id }, { throwOnError: true })
        toast.show({
          title: result.data.target.name,
          message:
            tested.data.status === "ready"
              ? "Target verified"
              : `Saved unverified · ${tested.data.stage}: ${tested.data.message}`,
          variant: tested.data.status === "ready" ? "success" : "warning",
        })
        openTargets()
      } catch (error) {
        toast.show({ title: "Target save failed", message: errorMessage(error), variant: "error" })
      }
    })()
  }

  const manage = (target: TargetDefinition) => {
    dialog.replace(() => (
      <DialogSelect
        title={target.name}
        options={[
          { title: "Test connection", value: "test" as const },
          { title: "Edit or rename", value: "edit" as const },
          { title: "Remove target", value: "remove" as const },
        ]}
        onSelect={(option) => {
          if (option.value === "edit") return save(target)
          if (option.value === "test") {
            void sdk.client.v2.target
              .test({ targetID: target.id }, { throwOnError: true })
              .then((result) =>
                toast.show({
                  title: target.name,
                  message: result.data.status === "ready" ? "Target ready" : `${result.data.stage}: ${result.data.message}`,
                  variant: result.data.status === "ready" ? "success" : "warning",
                }),
              )
              .catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
            return
          }
          void (async () => {
            const confirmed = await DialogConfirm.show(
              dialog,
              "Remove target",
              `Remove ${target.name} globally from this device? Referencing Sessions are preserved as unresolved.`,
            )
            if (!confirmed || !targets()) return
            await sdk.client.v2.target.remove(
              { targetID: target.id, expectedRevision: targets()!.revision },
              { throwOnError: true },
            )
            await targetsControl.refetch()
            openManager()
          })().catch((error) => toast.show({ message: errorMessage(error), variant: "error" }))
        }}
      />
    ))
  }

  const openManager = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Manage targets"
        options={[
          { title: "Add target…", value: undefined, category: "Actions" },
          ...(targets()?.targets ?? []).map((target) => ({
            title: target.name,
            description: target.connection.host,
            value: target as TargetDefinition,
            category: "Configured targets",
          })),
        ]}
        onSelect={(option) => (option.value ? manage(option.value) : save())}
      />
    ))
  }

  const openTargets = () => {
    dialog.replace(() => (
      <DialogSelect
        title="Execution target"
        locked={targets.loading}
        options={[
          { title: "local", description: paths.cwd, value: "local" as const, category: "Targets" },
          ...(targets()?.targets ?? []).map((target) => ({
            title: target.name,
            description: target.defaultDirectory ?? target.workspaceRoots[0],
            value: target as TargetDefinition | "local" | "manage",
            category: "Targets",
          })),
          { title: "Manage targets…", value: "manage" as const, category: "Actions" },
        ]}
        onSelect={(option) => {
          if (option.value === "manage") return openManager()
          if (option.value === "local") {
            destination?.setTarget({ type: "local" })
            destination?.setDestination({ type: "directory", directory: paths.cwd, subdirectory: false })
            return openDirectory()
          }
          choose(option.value)
        }}
      />
    ))
  }

  return (
    <box flexDirection="row" gap={1} flexShrink={1} overflow="hidden">
      <text fg={theme().textMuted} onMouseUp={openTargets} flexShrink={0}>
        {destination?.target().type === "rexd" ? (destination.target() as Extract<HomeSessionTarget, { type: "rexd" }>).name : "local"}
      </text>
      <text fg={theme().textMuted}>·</text>
      <Show when={dir()}>{(value) => <text fg={theme().textMuted} onMouseUp={openDirectory}>{value()}</text>}</Show>
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
