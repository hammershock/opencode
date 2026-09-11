import type { TuiDialogSelectOption } from "@opencode-ai/plugin/tui"
import type { JSX } from "solid-js"
import type { DialogContext } from "../../src/ui/dialog"
import type { DialogSelectOption } from "../../src/ui/dialog-select"

const eager = null as JSX.Element

// @ts-expect-error retained JSX must be rejected before it can outlive a dialog
const internalEager: DialogSelectOption<string> = { title: "eager", value: "eager", footer: eager }
// @ts-expect-error plugins must use the same lifecycle-safe view contract
const pluginEager: TuiDialogSelectOption<string> = { title: "eager", value: "eager", footer: eager }

const internalLazy: DialogSelectOption<string> = { title: "lazy", value: "lazy", footer: () => eager }
const pluginLazy: TuiDialogSelectOption<string> = { title: "lazy", value: "lazy", footer: () => eager }
const replace = null as unknown as DialogContext["replace"]

if (false) {
  // @ts-expect-error dialogs must receive a factory so creation happens under the modal owner
  replace(eager)
  replace(() => eager)
}

void internalEager
void pluginEager
void internalLazy
void pluginLazy
