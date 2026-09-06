import path from "path"
import { createResource, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useSDK } from "../context/sdk"
import type { HomeSessionTarget } from "../routes/home/session-destination"

type Selection = { type: "use" | "directory"; directory: string }

export function DialogLocationDirectory(props: {
  target: HomeSessionTarget
  initial: string
  onSelect: (directory: string) => void
}) {
  const sdk = useSDK()
  const [current, setCurrent] = createSignal(props.initial)
  const [directory] = createResource(current, async (current) => {
    const target =
      props.target.type === "local"
        ? ({ type: "local" } as const)
        : ({ type: "rexd", targetID: props.target.targetID } as const)
    const result = await sdk.client.v2.fs.list(
      {
        location: {
          directory: current,
          ...(target.type === "rexd" ? { target: target.targetID } : {}),
        },
        path: ".",
      },
      { throwOnError: true },
    )
    return {
      current,
      entries: result.data.data.filter((item) => item.type === "directory"),
    }
  })
  const options = (): DialogSelectOption<Selection>[] => {
    const current = directory()?.current ?? props.initial
    const parent = path.posix.dirname(current)
    return [
      { title: "Use this directory", description: current, value: { type: "use", directory: current } },
      ...(parent === current
        ? []
        : [{ title: "..", description: parent, value: { type: "directory" as const, directory: parent } }]),
      ...(directory()?.entries ?? []).map((item) => ({
        title: path.posix.basename(item.path),
        value: { type: "directory" as const, directory: item.path },
      })),
    ]
  }
  return (
    <DialogSelect
      title={`${props.target.type === "local" ? "local" : props.target.name} · ${directory()?.current ?? props.initial}`}
      options={options()}
      locked={directory.loading}
      onSelect={(option) => {
        if (option.value.type === "use") return props.onSelect(option.value.directory)
        setCurrent(option.value.directory)
      }}
    />
  )
}
