import { TextAttributes } from "@opentui/core"
import { createMemo } from "solid-js"
import { experimentalCommandSettings, overrideDiagnostic } from "../command-toolkit/experimental-settings"
import { useKV } from "../context/kv"
import { useTheme } from "../context/theme"
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
  const options = createMemo(() =>
    experimentalCommandSettings.map((setting) => ({
      value: setting.id,
      title: setting.title,
      description: setting.description,
      footer: <Status setting={setting} />,
      category: "Experimental commands",
    })),
  )

  return (
    <DialogSelect
      title="Experimental commands"
      options={options()}
      actions={[
        {
          command: "dialog.experimental.toggle",
          title: "toggle",
          onTrigger: (option: DialogSelectOption<string>) => {
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
