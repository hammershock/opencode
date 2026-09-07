import type { DialogContext } from "../ui/dialog"
import { DialogAlert } from "../ui/dialog-alert"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogSelect } from "../ui/dialog-select"
import { revealEnvironment, type EnvironmentMetadata, type EnvironmentValues } from "../command-toolkit/environment"

export function showEnvironment(
  dialog: DialogContext,
  snapshot: EnvironmentMetadata,
  reveal: () => Promise<EnvironmentValues>,
  onError: (error: unknown) => void,
) {
  return new Promise<void>((resolve) => {
    dialog.replace(
      () => (
        <DialogSelect
          title={`Environment · generation ${snapshot.generation}`}
          options={snapshot.variables.map((variable) => ({
            title: variable.name,
            description: variable.source,
            footer: variable.origin,
            value: variable.name,
          }))}
          actions={[
            {
              command: "dialog.environment.reveal",
              title: "reveal values",
              onTrigger: () =>
                void revealEnvironment({
                  confirm: async () =>
                    Boolean(
                      await DialogConfirm.show(
                        dialog,
                        "Reveal environment values?",
                        "Values are sensitive and remain visible only until this dialog closes.",
                      ),
                    ),
                  reveal,
                  present: (values) =>
                    DialogAlert.show(
                      dialog,
                      `Environment values · generation ${values.generation}`,
                      Object.entries(values.values)
                        .map(([name, value]) => `${name}=${value}`)
                        .join("\n") || "No values",
                    ),
                }).catch(onError),
            },
          ]}
          onSelect={() => {}}
        />
      ),
      resolve,
    )
  })
}
