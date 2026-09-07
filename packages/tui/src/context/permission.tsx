import { createStore } from "solid-js/store"
import { useArgs } from "./args"
import { createSimpleContext } from "./helper"
import { useKV } from "./kv"

export type PermissionMode = "auto" | "normal"

export const { use: usePermission, provider: PermissionProvider } = createSimpleContext({
  name: "Permission",
  init: () => {
    const args = useArgs()
    const kv = useKV()
    const [store, setStore] = createStore<{ defaultMode: PermissionMode }>({
      defaultMode: kv.get("permission_default_mode", args.auto ? "auto" : "normal"),
    })
    return {
      get defaultMode() {
        return store.defaultMode
      },
      setDefault(mode: PermissionMode) {
        setStore("defaultMode", mode)
        kv.set("permission_default_mode", mode)
      },
      toggleDefault() {
        this.setDefault(store.defaultMode === "auto" ? "normal" : "auto")
      },
      effective(mode: PermissionMode) {
        return args.auto ? "auto" : mode
      },
    }
  },
})
