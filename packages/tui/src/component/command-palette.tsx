import { createMemo } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../ui/dialog-select"
import { type DialogContext } from "../ui/dialog"
import {
  COMMAND_PALETTE_COMMAND,
  formatKeyBindings,
  type OpenTuiKeymap,
  useKeymapSelector,
  useOpencodeKeymap,
} from "../keymap"
import { useTuiConfig } from "../config"
import { isCoreCommandMetadata, provenanceLabel, resolveUpstreamCandidates } from "../command-toolkit/host"
import type { CommandProvenance } from "@opencode-ai/command-kit"
import { adaptKeymapCommands, adaptServerCommands } from "../command-toolkit/upstream"
import { useSync } from "../context/sync"

type PaletteCommandEntry = ReturnType<OpenTuiKeymap["getCommandEntries"]>[number]

function isVisiblePaletteCommand(command: PaletteCommandEntry["command"]) {
  return command.hidden !== true && command.name !== COMMAND_PALETTE_COMMAND
}

function isSuggestedPaletteCommand(entry: PaletteCommandEntry) {
  const suggested = entry.command.suggested
  if (typeof suggested === "boolean") return suggested
  if (typeof suggested === "function") return suggested() === true
  return false
}

export function CommandPaletteDialog() {
  const config = useTuiConfig()
  const keymap = useOpencodeKeymap()
  const sync = useSync()
  const entries = useKeymapSelector((keymap: OpenTuiKeymap) => {
    const query = {
      namespace: "palette",
    }
    const reachable = keymap.getCommandEntries({
      ...query,
      visibility: "reachable",
      filter: isVisiblePaletteCommand,
    })
    const registeredBindings = keymap.getCommandBindings({
      visibility: "registered",
      commands: reachable.map((entry) => entry.command.name),
    })

    return reachable.map((entry) => ({
      ...entry,
      bindings: registeredBindings.get(entry.command.name) ?? entry.bindings,
    }))
  })
  const options = createMemo(() => {
    const current = entries()
    const upstream = [...adaptServerCommands(sync.data.command), ...adaptKeymapCommands(current, () => undefined)]
    return current.flatMap((entry) => {
      const metadata = entry.command as typeof entry.command & {
        commandKitProvenance?: CommandProvenance
        commandKitPath?: readonly string[]
      }
      if (isCoreCommandMetadata(metadata)) {
        const source = `/${metadata.commandKitPath.join(" ")}`
        if (resolveUpstreamCandidates(source, upstream).length > 0) return []
      }
      const provenance = metadata.commandKitProvenance
      const label = provenance ? provenanceLabel(provenance) : "upstream"
      const description = typeof entry.command.desc === "string" ? entry.command.desc : undefined
      return [
        {
          title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
          description: provenance ? description : description ? `${description} · ${label}` : label,
          category: typeof entry.command.category === "string" ? entry.command.category : undefined,
          footer: formatKeyBindings(entry.bindings, config),
          value: entry.command.name,
          suggested: isSuggestedPaletteCommand(entry),
          onSelect: (dialog: DialogContext) => {
            dialog.clear()
            keymap.dispatchCommand(entry.command.name)
          },
        },
      ]
    })
  })

  let ref: DialogSelectRef<string>
  const list = () => {
    if (ref?.filter) return options()
    return [
      ...options()
        .filter((option) => option.suggested)
        .map((option) => ({
          ...option,
          value: `suggested:${option.value}`,
          category: "Suggested",
        })),
      ...options(),
    ]
  }

  return <DialogSelect ref={(value) => (ref = value)} title="Commands" options={list()} />
}
