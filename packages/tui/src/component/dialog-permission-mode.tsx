import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useLocal } from "../context/local"

export function DialogPermissionMode() {
  const dialog = useDialog()
  const local = useLocal()
  return (
    <DialogSelect
      title="Permission mode"
      current={local.permission.mode}
      options={[
        {
          title: "Ask according to configured rules",
          description: "Prompt when a permission rule requires confirmation",
          value: "normal" as const,
        },
        {
          title: "Auto-approve unless explicitly denied",
          description: "Approve requests that are not rejected by an explicit rule",
          value: "auto" as const,
        },
      ]}
      onSelect={(option) => {
        local.permission.set(option.value)
        dialog.clear()
      }}
    />
  )
}
