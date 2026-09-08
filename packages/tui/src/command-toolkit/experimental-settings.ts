import type { OverrideDiagnostic } from "@opencode-ai/command-kit"
import { SESSION_RENAME_DIRECT_SETTING } from "./session-rename"

export type ExperimentalCommandSetting = {
  id: string
  key: string
  title: string
  description: string
  defaultValue: false
}

export const SESSION_EXIT_TO_HOME_SETTING = "experimental.commands.exit_to_home"
export const SESSION_FORCE_REBIND_SETTING = "experimental.session.force_rebind"

export const experimentalCommandSettings = [
  {
    id: "fork.session.exit-to-home",
    key: SESSION_EXIT_TO_HOME_SETTING,
    title: "Exit Session to QuickStart",
    description: "Make /exit return from a Session to QuickStart while /quit and /q still exit the app",
    defaultValue: false,
  },
  {
    id: "fork.session.rename-direct",
    key: SESSION_RENAME_DIRECT_SETTING,
    title: "Direct session rename",
    description: "Allow /rename <title> to rename without asking the Agent",
    defaultValue: false,
  },
  {
    id: "fork.session.force-rebind",
    key: SESSION_FORCE_REBIND_SETTING,
    title: "Force Session Location rebind",
    description: "Allow an idle Session to move to another target and directory (not recommended)",
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

export async function persistLocationEnvironment(
  enabled: boolean,
  update: (config: { experimental: { location_env: boolean } }) => Promise<void>,
) {
  await update({ experimental: { location_env: enabled } })
  return enabled
}

export async function persistUserShellCwd(
  enabled: boolean,
  update: (config: { experimental: { user_shell_cwd: boolean } }) => Promise<void>,
) {
  await update({ experimental: { user_shell_cwd: enabled } })
  return enabled
}
