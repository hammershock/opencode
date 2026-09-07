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
import { getActiveCommandHost } from "../command-toolkit/host"
import { commandPaletteWinners } from "../command-toolkit/palette"
import { usePromptRef } from "../context/prompt"

type PaletteCommandEntry = ReturnType<OpenTuiKeymap["getCommandEntries"]>[number]

export function slashCommandPalettePresentation(command: { title: string; description?: string; category?: string }) {
  return { title: command.title, description: command.description, category: command.category }
}

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
  const promptRef = usePromptRef()
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
    const plain = current.filter((entry) => typeof entry.command.slashName !== "string" || !entry.command.slashName)
    const regular = plain.map((entry) => {
      const description = typeof entry.command.desc === "string" ? entry.command.desc : undefined
      return {
        title: typeof entry.command.title === "string" ? entry.command.title : entry.command.name,
        description,
        category: typeof entry.command.category === "string" ? entry.command.category : undefined,
        footer: formatKeyBindings(entry.bindings, config),
        value: entry.command.name,
        suggested: isSuggestedPaletteCommand(entry),
        onSelect: (dialog: DialogContext) => {
          dialog.clear()
          keymap.dispatchCommand(entry.command.name)
        },
      }
    })
    const winners = commandPaletteWinners(getActiveCommandHost(keymap)?.commands() ?? [])
    const slash = winners
      .filter((command) => !command.hidden && command.enabled)
      .map((command) => {
        const entry = current.find((item) => item.command.name === command.identity)
        return {
          ...slashCommandPalettePresentation(command),
          footer: entry ? formatKeyBindings(entry.bindings, config) : "",
          value: command.identity,
          suggested: entry ? isSuggestedPaletteCommand(entry) : false,
          onSelect: (dialog: DialogContext) => {
            dialog.clear()
            if (command.dispatch === "client") {
              void command.run("palette")
              return
            }
            const prompt = promptRef.current
            if (!prompt) return
            prompt.set({ ...prompt.current, input: `/${command.path.join(" ")} ` })
            prompt.focus()
          },
        }
      })
    return [...regular, ...slash]
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
