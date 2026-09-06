import { installUpstreamOverride, type OverrideWarning, type UpstreamOverride } from "@opencode-ai/command-kit"
import { SESSION_EXIT_TO_HOME_SETTING } from "./experimental-settings"
import { verifiedAppExit } from "./upstream-app"

export type SessionExitInput = { route: "session" | "home" | "other" }

const definition: UpstreamOverride<SessionExitInput, void> = {
  id: "fork.session.exit-to-home",
  target: verifiedAppExit,
  experimentalSetting: SESSION_EXIT_TO_HOME_SETTING,
  decorate: (next) => async (input) => {
    if (input.route !== "session") {
      await next(input)
      return { status: "handled", value: undefined }
    }
    return { status: "unavailable", reason: "navigation action is supplied by the TUI host" }
  },
}

export function installSessionExitOverride(input: {
  enabled: boolean
  exit: () => Promise<void> | void
  home: () => Promise<void> | void
  warning: (warning: OverrideWarning) => void
}) {
  const upstream = async (_value: SessionExitInput) => {
    await input.exit()
  }
  return installUpstreamOverride({
    definition: {
      ...definition,
      decorate: (next) => async (value) => {
        if (value.route !== "session") return definition.decorate(next)(value)
        try {
          await input.home()
          return { status: "handled", value: undefined }
        } catch (error) {
          return { status: "unavailable", reason: error instanceof Error ? error.name : "navigation failed" }
        }
      },
    },
    enabled: input.enabled,
    upstream,
    warning: input.warning,
  })
}
