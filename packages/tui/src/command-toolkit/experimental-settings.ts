import type { OverrideDiagnostic } from "@opencode-ai/command-kit"
import { SESSION_RENAME_DIRECT_SETTING } from "./session-rename"

export type ExperimentalCommandSetting = {
  id: string
  key: string
  title: string
  description: string
  defaultValue: false
}

export const experimentalCommandSettings = [
  {
    id: "fork.session.rename-direct",
    key: SESSION_RENAME_DIRECT_SETTING,
    title: "Direct session rename",
    description: "Allow /rename <title> to rename without asking the Agent",
    defaultValue: false,
  },
] as const satisfies readonly ExperimentalCommandSetting[]

const diagnostics = new Map<string, OverrideDiagnostic>()

export function reportOverrideDiagnostic(id: string, diagnostic: OverrideDiagnostic) {
  diagnostics.set(id, diagnostic)
}

export function overrideDiagnostic(id: string) {
  return diagnostics.get(id)
}
