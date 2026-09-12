import { TextAttributes, type ScrollBoxRenderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import type { ModelContextGeneration } from "../command-toolkit/model-context"
import { useTuiConfig } from "../config"
import { useClipboard } from "../context/clipboard"
import { useTheme } from "../context/theme"
import { formatKeyBindings, useBindings, useKeymapSelector } from "../keymap"
import { getScrollAcceleration } from "../util/scroll"
import { useDialog, type DialogContext } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"

type Preview = { title: string; content: string }

const scrollCommands = [
  "dialog.model_context.line_up",
  "dialog.model_context.line_down",
  "dialog.model_context.page_up",
  "dialog.model_context.page_down",
] as const

const scrollHintCommands = ["dialog.model_context.line_up", "dialog.model_context.line_down"] as const

const commands = [
  ...scrollCommands,
  "dialog.model_context.home",
  "dialog.model_context.end",
  "dialog.model_context.copy",
] as const

export function modelContextOptions(generation: ModelContextGeneration): DialogSelectOption<Preview>[] {
  const environment = generation.environment
  const options: DialogSelectOption<Preview>[] = []

  for (const [key, source] of Object.entries(generation.sources)) {
    if (key === "core/environment") {
      options.push({
        category: "Environment",
        title: `${environment.targetName} · ${environment.targetKind}`,
        description: environment.directory,
        details: [`project ${environment.projectRoot}`],
        footer: `${environment.platform} · ${environment.vcs ?? "no vcs"}`,
        value: {
          title: "Environment",
          content: generation.sources["core/environment"]?.baseline ?? JSON.stringify(environment, null, 2),
        },
      })
      continue
    }
    if (key === "core/instructions") {
      for (const instruction of generation.instructions) {
        const detail = `${instruction.origin} · ${instruction.scope} · ${instruction.status}`
        options.push({
          category: "Instructions",
          title: instruction.source,
          description: detail,
          details: instruction.declaredBy ? [`declared by ${instruction.declaredBy}`] : undefined,
          footer:
            instruction.status === "ignored"
              ? `${instruction.failureStage ?? "load"} failed`
              : instruction.digest?.slice(0, 12),
          value: {
            title: instruction.source,
            content:
              instruction.status === "ignored"
                ? `Ignored during ${instruction.failureStage ?? "load"}.`
                : instruction.content || "(empty instruction file)",
          },
        })
      }
      continue
    }
    options.push({
      category: "Context",
      title: key,
      description: source.refresh === "generation" ? "generation" : "dynamic",
      value: { title: key, content: source.baseline ?? JSON.stringify(source.value, null, 2) },
    })
  }
  if (generation.skillGuidance) {
    options.push({
      category: "Skills",
      title: "available_skills",
      description: `${generation.skillCatalog?.skills.length ?? 0} available · controller-local`,
      footer: generation.skillCatalog?.digest.slice(0, 12),
      value: { title: "Available skills", content: generation.skillGuidance },
    })
  }
  return options
}

export function showModelContext(dialog: DialogContext, generation: ModelContextGeneration | null) {
  if (!generation) return DialogAlert.show(dialog, "Model context", "No context generation has been established yet.")
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect
          title={`Model context · ${generation.generation} · ${generation.reason}`}
          options={modelContextOptions(generation)}
          footer={<text>{`location ${generation.locationRevision} · ${generation.digest.slice(0, 12)}`}</text>}
          footerHints={[{ title: "enter", label: "preview" }]}
          onSelect={(option) =>
            dialog.replace(() => (
              <DialogModelContextPreview title={option.value.title} content={option.value.content} />
            ))
          }
        />
      ),
      resolve,
    )
  })
}

export function DialogModelContextPreview(props: Preview) {
  const dialog = useDialog()
  const clipboard = useClipboard()
  const dimensions = useTerminalDimensions()
  const tuiConfig = useTuiConfig()
  const toast = useToast()
  const { theme } = useTheme()
  const [copied, setCopied] = createSignal(false)
  const height = createMemo(() => Math.max(3, Math.floor((dimensions().height * 3) / 4) - 8))
  const scrollAcceleration = createMemo(() => getScrollAcceleration(tuiConfig))
  const bindings = useKeymapSelector((keymap) => keymap.getCommandBindings({ visibility: "registered", commands }))
  const scrollLabel = createMemo(() =>
    formatKeyBindings(
      scrollHintCommands.flatMap((command) => bindings().get(command) ?? []),
      tuiConfig,
    ),
  )
  const copyLabel = createMemo(() => formatKeyBindings(bindings().get("dialog.model_context.copy"), tuiConfig))
  let scroll: ScrollBoxRenderable | undefined

  dialog.setSize("xlarge")

  function copy() {
    if (!clipboard.write) {
      toast.show({ message: "Clipboard is unavailable", variant: "error" })
      return
    }
    void clipboard.write(props.content).then(
      () => {
        setCopied(true)
        toast.show({ message: "Context source copied to clipboard", variant: "success" })
      },
      () => {
        setCopied(false)
        toast.show({ message: "Failed to copy context source", variant: "error" })
      },
    )
  }

  useBindings(() => ({
    commands: [
      {
        name: "dialog.model_context.line_up",
        title: "Scroll up",
        category: "Dialog",
        run: () => scroll?.scrollBy(-1),
      },
      {
        name: "dialog.model_context.line_down",
        title: "Scroll down",
        category: "Dialog",
        run: () => scroll?.scrollBy(1),
      },
      {
        name: "dialog.model_context.page_up",
        title: "Page up",
        category: "Dialog",
        run: () => scroll?.scrollBy(-scroll.height),
      },
      {
        name: "dialog.model_context.page_down",
        title: "Page down",
        category: "Dialog",
        run: () => scroll?.scrollBy(scroll.height),
      },
      {
        name: "dialog.model_context.home",
        title: "First line",
        category: "Dialog",
        run: () => scroll?.scrollTo(0),
      },
      {
        name: "dialog.model_context.end",
        title: "Last line",
        category: "Dialog",
        run: () => scroll?.scrollTo(scroll.scrollHeight),
      },
      {
        name: "dialog.model_context.copy",
        title: "Copy source",
        category: "Dialog",
        run: copy,
      },
    ],
    bindings: tuiConfig.keybinds.gather("dialog.model_context", commands),
  }))

  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox
        ref={(element: ScrollBoxRenderable) => (scroll = element)}
        maxHeight={height()}
        paddingRight={1}
        scrollAcceleration={scrollAcceleration()}
        verticalScrollbarOptions={{
          trackOptions: {
            backgroundColor: theme.background,
            foregroundColor: theme.borderActive,
          },
        }}
      >
        <text fg={theme.text} wrapMode="word">
          {props.content}
        </text>
      </scrollbox>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.textMuted}>{scrollLabel()} scroll</text>
        <text onMouseUp={copy}>
          <span style={{ fg: copied() ? theme.success : theme.text }}>
            <b>{copied() ? "copied" : "copy"}</b>{" "}
          </span>
          <span style={{ fg: theme.textMuted }}>{copyLabel()}</span>
        </text>
      </box>
    </box>
  )
}
