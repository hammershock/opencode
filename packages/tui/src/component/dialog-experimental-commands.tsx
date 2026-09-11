import { TextAttributes } from "@opentui/core"
import { createMemo, createSignal, onMount } from "solid-js"
import {
  experimentalCommandSettings,
  overrideDiagnostic,
  persistLocationEnvironment,
  persistUserShellCwd,
} from "../command-toolkit/experimental-settings"
import { useKV } from "../context/kv"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useToast } from "../ui/toast"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

function Status(props: { setting: (typeof experimentalCommandSettings)[number] }) {
  const kv = useKV()
  const { theme } = useTheme()
  const enabled = () => kv.get(props.setting.key, props.setting.defaultValue)
  const diagnostic = () => overrideDiagnostic(props.setting.id)

  return (
    <span
      style={{
        fg: diagnostic()?.status === "fallback" ? theme.warning : enabled() ? theme.success : theme.textMuted,
        attributes: enabled() ? TextAttributes.BOLD : undefined,
      }}
    >
      {diagnostic()?.status === "fallback" ? "! Enabled but not active" : enabled() ? "✓ Enabled" : "○ Disabled"}
    </span>
  )
}

export function DialogExperimentalCommands() {
  const kv = useKV()
  const sdk = useSDK()
  const toast = useToast()
  const [locationEnvironment, setLocationEnvironment] = createSignal<boolean>()
  const [userShellCwd, setUserShellCwd] = createSignal<boolean>()
  onMount(
    () =>
      void sdk.client.global.config
        .get({ throwOnError: true })
        .then((result) => {
          setLocationEnvironment(result.data.experimental?.location_env === true)
          setUserShellCwd(result.data.experimental?.user_shell_cwd === true)
        })
        .catch(toast.error),
  )
  const options = createMemo(() => [
    ...experimentalCommandSettings.map((setting) => ({
      value: setting.id,
      title: setting.title,
      description: setting.description,
      footer: () => <Status setting={setting} />,
      category: "Experimental commands",
    })),
    {
      value: "fork.user-shell.cwd",
      title: "User Shell CWD continuity",
      description: "User setting · remember verified cwd until OpenCode exits",
      footer: userShellCwd() === undefined ? "◐ checking" : userShellCwd() ? "● enabled" : "○ disabled",
      category: "Experimental features",
      disabled: userShellCwd() === undefined,
    },
    {
      value: "fork.environment.location",
      title: "Location environment",
      description: "User setting · load target user and project .env files for Shell and Agent tools",
      footer: locationEnvironment() === undefined ? "◐ checking" : locationEnvironment() ? "● enabled" : "○ disabled",
      category: "Experimental features",
      disabled: locationEnvironment() === undefined,
    },
  ])

  return (
    <DialogSelect
      title="Experimental commands"
      options={options()}
      actions={[
        {
          command: "dialog.experimental.toggle",
          title: "toggle",
          onTrigger: (option: DialogSelectOption<string>) => {
            if (option.value === "fork.user-shell.cwd") {
              const current = userShellCwd()
              if (current === undefined) return
              const enabled = !current
              void persistUserShellCwd(enabled, async (config) => {
                await sdk.client.global.config.update({ config }, { throwOnError: true })
              })
                .then(setUserShellCwd)
                .catch(toast.error)
              return
            }
            if (option.value === "fork.environment.location") {
              const current = locationEnvironment()
              if (current === undefined) return
              const enabled = !current
              void persistLocationEnvironment(enabled, async (config) => {
                await sdk.client.global.config.update({ config }, { throwOnError: true })
              })
                .then(setLocationEnvironment)
                .catch(toast.error)
              return
            }
            const setting = experimentalCommandSettings.find((item) => item.id === option.value)
            if (!setting) return
            kv.set(setting.key, !kv.get(setting.key, setting.defaultValue))
          },
        },
      ]}
      onSelect={() => {}}
    />
  )
}
