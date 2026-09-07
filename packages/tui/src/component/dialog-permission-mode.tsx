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
