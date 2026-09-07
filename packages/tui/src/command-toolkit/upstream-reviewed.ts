import { defineUpstreamCommand } from "@opencode-ai/command-kit"

/** Pinned baseline changed only after reviewing the corresponding upstream registration. */
export const reviewedUpstreamCommands = {
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
