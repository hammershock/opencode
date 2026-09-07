import { installUpstreamOverride, type OverrideWarning } from "@opencode-ai/command-kit"
import { verifiedSessionRename } from "./upstream-session"

export const SESSION_RENAME_DIRECT_SETTING = "experimental.commands.rename_direct"

export type SessionRenameInput = {
  title: string
}

export function parseSessionRenameArguments(title: string) {
  if (/\r|\n/.test(title)) return { status: "invalid", message: "Session titles must be a single line" } as const
  return { status: "parsed", input: { title } } as const
}

export function installSessionRenameOverride(input: {
  enabled: boolean
  upstream: (input: SessionRenameInput) => Promise<void>
  rename: (title: string) => Promise<void>
  warning: (warning: OverrideWarning) => void
}) {
  return installUpstreamOverride({
    enabled: input.enabled,
    upstream: input.upstream,
    warning: input.warning,
    definition: {
      id: "fork.session.rename-direct",
      target: verifiedSessionRename,
      experimentalSetting: SESSION_RENAME_DIRECT_SETTING,
      decorate: (next) => async (value) => {
        const title = value.title.trim()
        if (!title) return { status: "handled", value: await next(value) }
        if (/\r|\n/.test(title)) return { status: "unavailable", reason: "invalid title reached rename service" }
        await input.rename(title)
        return { status: "handled", value: undefined }
      },
    },
  })
}
