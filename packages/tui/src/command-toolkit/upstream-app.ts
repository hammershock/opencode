import { defineUpstreamCommand, verifyUpstreamCommand } from "@opencode-ai/command-kit"

const reviewedAppExit = defineUpstreamCommand(
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
)

const currentAppExit = defineUpstreamCommand(
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
)

// Deliberately checked by TypeScript. Upstream registration drift must be
// reviewed here before a build can succeed.
export const verifiedAppExit = verifyUpstreamCommand(reviewedAppExit, currentAppExit)

export const appExitMetadata = {
  title: verifiedAppExit.contract.title,
  category: verifiedAppExit.contract.category,
  slash: {
    name: verifiedAppExit.contract.path[0],
    aliases: verifiedAppExit.contract.aliases.flatMap((alias) => alias[0] ?? []),
  },
} as const
