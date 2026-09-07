import { Prompt, type PromptRef } from "../component/prompt"
import { createEffect, createMemo, createSignal, onMount } from "solid-js"
import { Logo } from "../component/logo"
import { useSync } from "../context/sync"
import { Toast } from "../ui/toast"
import { useArgs } from "../context/args"
import { useRouteData } from "../context/route"
import { usePromptRef } from "../context/prompt"
import { useLocal } from "../context/local"
import { usePluginRuntime } from "../plugin/runtime"
import { useEditorContext } from "../context/editor"
import { useTerminalDimensions } from "@opentui/solid"
import { useTuiConfig } from "../config"
import { HomeSessionDestinationProvider } from "./home/session-destination"
import { COMMAND_RESTRICTIONS_KEY, createCommandHost, normalizeCommandRestrictions } from "../command-toolkit/host"
import { approvalModeCommand, type ApprovalModeCommandContext } from "../command-toolkit/approval-mode"
import { useBindings, useKeymapSelector, useOpencodeKeymap } from "../keymap"
import { useDialog } from "../ui/dialog"
import { DialogPermissionMode } from "../component/dialog-permission-mode"
import { useToast } from "../ui/toast"
import { syncCommands, type SyncCommandContext } from "../command-toolkit/sync"
import { useSyncSettings } from "../context/sync-settings"
import { useTheme } from "../context/theme"
import { targetCommand, type TargetCommandContext } from "../command-toolkit/target"
import { useTargetManager } from "../component/target-manager"
import { adaptKeymapCommands, adaptServerCommands } from "../command-toolkit/upstream"
import { useKV } from "../context/kv"

let once = false
const placeholder = {
  normal: ["Fix a TODO in the codebase", "What is the tech stack of this project?", "Fix broken tests"],
  shell: ["ls -la", "git status", "pwd"],
}

export function openQuickStartSync(open: (view: "overview") => Promise<unknown> | unknown) {
  return open("overview")
}

export function Home() {
  const pluginRuntime = usePluginRuntime()
  const sync = useSync()
  const route = useRouteData("home")
  const promptRef = usePromptRef()
  const [ref, setRef] = createSignal<PromptRef | undefined>()
  const args = useArgs()
  const local = useLocal()
  const editor = useEditorContext()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const dialog = useDialog()
  const toast = useToast()
  const syncSettings = useSyncSettings()
  const { theme } = useTheme()
  const targetManager = useTargetManager()
  const keymap = useOpencodeKeymap()
  const upstreamCommandEntries = useKeymapSelector((value) =>
    value.getCommandEntries({ visibility: "reachable", namespace: "palette" }),
  )
  const kv = useKV()
  const syncColor = createMemo(() => {
    const state = syncSettings.model().state
    if (state === "idle") return theme.success
    if (state === "attention") return theme.error
    if (state === "syncing" || state === "locked") return theme.warning
    return theme.textMuted
  })
  const commandHost = createMemo(() =>
    createCommandHost<ApprovalModeCommandContext & SyncCommandContext & TargetCommandContext>({
      register: (registry) => {
        registry.register(approvalModeCommand)
        registry.register(targetCommand)
        syncCommands.forEach((command) => registry.register(command))
      },
      context: (source) => ({
        source,
        client: "tui",
        abortSignal: new AbortController().signal,
        confirm: async () => false,
        approvalMode: {
          open: () =>
            dialog.replace(() => (
              <DialogPermissionMode
                scope="Default"
                mode={local.permission.defaultMode}
                set={(mode) => {
                  local.permission.setDefault(mode)
                }}
              />
            )),
        },
        openTargetManager: targetManager.open,
        openSyncSettings: syncSettings.open,
      }),
      upstream: () => [
        ...adaptServerCommands(sync.data.command),
        ...adaptKeymapCommands(upstreamCommandEntries(), (identity) => keymap.dispatchCommand(identity)),
      ],
      restrictions: () => normalizeCommandRestrictions(kv.get(COMMAND_RESTRICTIONS_KEY)),
      diagnostic: (diagnostic) => console.warn("[command-kit] shadowed command", diagnostic),
      invalid: (message) => toast.show({ message, variant: "warning" }),
      outcome: (message, status) =>
        toast.show({
          message,
          variant: status === "failed" ? "error" : status === "cancelled" ? "warning" : "success",
        }),
    }),
  )

  useBindings(() => ({ commands: commandHost().registrations() }))
  const promptMaxWidth = createMemo(() => {
    const configured = tuiConfig.prompt?.max_width
    if (configured === "auto") return Math.max(75, Math.floor(dimensions().width * 0.7))
    return configured ?? 75
  })
  let sent = false

  onMount(() => {
    editor.clearSelection()
  })

  const bind = (r: PromptRef | undefined) => {
    setRef(r)
    promptRef.set(r)
    if (once || !r) return
    if (route.prompt) {
      r.set(route.prompt)
      once = true
      return
    }
    if (!args.prompt) return
    r.set({ input: args.prompt, parts: [] })
    once = true
  }

  // Wait for sync and model store to be ready before auto-submitting --prompt
  createEffect(() => {
    const r = ref()
    if (sent) return
    if (!r) return
    if (!sync.ready || !local.model.ready) return
    if (!args.prompt) return
    if (r.current.input !== args.prompt) return
    sent = true
    r.submit()
  })

  return (
    <HomeSessionDestinationProvider>
      <box flexGrow={1} alignItems="center" paddingLeft={2} paddingRight={2}>
        <box flexGrow={1} minHeight={0} />
        <box height={4} minHeight={0} flexShrink={1} />
        <box flexShrink={0}>
          <pluginRuntime.Slot name="home_logo" mode="replace">
            <Logo />
          </pluginRuntime.Slot>
        </box>
        <box height={1} minHeight={0} flexShrink={1} />
        <box width="100%" maxWidth={promptMaxWidth()} zIndex={1000} paddingTop={1} flexShrink={0}>
          <pluginRuntime.Slot name="home_prompt" mode="replace" ref={bind}>
            <Prompt
              ref={bind}
              right={<pluginRuntime.Slot name="home_prompt_right" />}
              placeholders={placeholder}
              commandHost={commandHost()}
            />
          </pluginRuntime.Slot>
        </box>
        <box width="100%" maxWidth={promptMaxWidth()} justifyContent="flex-end" flexShrink={0}>
          <text fg={syncColor()} onMouseUp={() => void openQuickStartSync(syncSettings.open)}>
            Sync {syncSettings.status()}
          </text>
        </box>
        <pluginRuntime.Slot name="home_bottom" />
        <box flexGrow={1} minHeight={0} />
        <Toast />
      </box>
      <box width="100%" flexShrink={0}>
        <pluginRuntime.Slot name="home_footer" mode="single_winner" />
      </box>
    </HomeSessionDestinationProvider>
  )
}
