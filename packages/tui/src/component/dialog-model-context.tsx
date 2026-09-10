import type { ModelContextGeneration } from "../command-toolkit/model-context"
import type { DialogContext } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"

type Preview = { title: string; content: string }

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
          onSelect={(option) => void DialogAlert.show(dialog, option.value.title, option.value.content)}
        />
      ),
      resolve,
    )
  })
}
