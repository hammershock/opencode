import { verifyUpstreamCommand } from "@opencode-ai/command-kit"
import { currentUpstreamCommands } from "./upstream-current"
import { reviewedUpstreamCommands } from "./upstream-reviewed"

// Deliberately checked by TypeScript. Upstream registration drift must be
// reviewed here before a build can succeed.
export const verifiedAppExit = verifyUpstreamCommand(reviewedUpstreamCommands.appExit, currentUpstreamCommands.appExit)

export const appExitMetadata = {
  name: verifiedAppExit.contract.identity,
  title: verifiedAppExit.contract.title,
  category: verifiedAppExit.contract.category,
  slash: {
    name: verifiedAppExit.contract.path[0],
    aliases: verifiedAppExit.contract.aliases.flatMap((alias) => alias[0] ?? []),
  },
} as const
