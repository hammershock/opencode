import { defineUpstreamCommand } from "@opencode-ai/command-kit"

/**
 * Registration-facing manifest. TUI command hosts consume metadata derived from
 * these entries, so source registration drift cannot bypass static verification.
 */
export const currentUpstreamCommands = {
  appExit: defineUpstreamCommand(
    {
      identity: "app.exit",
      host: "tui.app",
      path: ["exit"],
      aliases: [["quit"], ["q"]],
      title: "Exit the app",
      category: "System",
      availability: "all-routes",
      inputBoundary: "no-arguments",
    },
    "337fd144d2ba:app.exit:v1",
  ),
  sessionRename: defineUpstreamCommand(
    {
      identity: "session.rename",
      host: "tui.session",
      path: ["rename"],
      aliases: [],
      title: "Rename session",
      category: "Session",
      availability: "session-route",
      inputBoundary: "no-arguments",
    },
    "337fd144d2ba:session.rename:v1",
  ),
} as const
