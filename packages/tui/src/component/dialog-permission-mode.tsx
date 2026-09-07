import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import type { PermissionMode } from "../context/permission"

export function DialogPermissionMode(props: {
  scope: "Default" | "Session"
  mode: PermissionMode
  set: (mode: PermissionMode) => Promise<void> | void
}) {
  const dialog = useDialog()
  return (
    <DialogSelect
      title={`${props.scope} permission mode`}
      current={props.mode}
      options={[
        {
          title: "Disable auto-approve",
          description: "Prompt when a permission rule requires confirmation",
          value: "normal" as const,
        },
        {
          title: "Enable auto-approve",
          description: "Approve requests that are not rejected by an explicit rule",
          value: "auto" as const,
        },
      ]}
      onSelect={async (option) => {
        await props.set(option.value)
        dialog.clear()
      }}
    />
  )
}

export function DialogPermissionModes(props: {
  defaultMode: PermissionMode
  sessionMode: PermissionMode
  setDefault: (mode: PermissionMode) => Promise<void> | void
  setSession: (mode: PermissionMode) => Promise<void> | void
}) {
  const dialog = useDialog()
  const choices = () => permissionModeActions(props)
  return (
    <DialogSelect
      title="Permission modes"
      options={choices()}
      onSelect={async (option) => {
        await choices()
          .find((choice) => choice.value === option.value)!
          .run()
        dialog.clear()
      }}
    />
  )
}

export function permissionModeActions(input: {
  defaultMode: PermissionMode
  sessionMode: PermissionMode
  setDefault: (mode: PermissionMode) => Promise<void> | void
  setSession: (mode: PermissionMode) => Promise<void> | void
}) {
  const action = (mode: PermissionMode) => (mode === "auto" ? "Disable auto-approve" : "Enable auto-approve")
  const next = (mode: PermissionMode): PermissionMode => (mode === "auto" ? "normal" : "auto")
  return [
    {
      title: `Default · ${action(input.defaultMode)}`,
      description: `Currently ${input.defaultMode} · copied only to new Sessions`,
      value: "default" as const,
      run: () => input.setDefault(next(input.defaultMode)),
    },
    {
      title: `Session · ${action(input.sessionMode)}`,
      description: `Currently ${input.sessionMode} · changes only this durable Session`,
      value: "session" as const,
      run: () => input.setSession(next(input.sessionMode)),
    },
  ]
}
