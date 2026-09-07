import { verifyUpstreamCommand } from "@opencode-ai/command-kit"
import { currentUpstreamCommands } from "./upstream-current"
import { reviewedUpstreamCommands } from "./upstream-reviewed"

// This is intentionally evaluated by TypeScript, not discovered in production.
// Any source-side contract edit must update the reviewed baseline in the same PR.
export const verifiedSessionRename = verifyUpstreamCommand(
  reviewedUpstreamCommands.sessionRename,
  currentUpstreamCommands.sessionRename,
)

export const sessionRenameMetadata = {
  title: verifiedSessionRename.contract.title,
  value: verifiedSessionRename.contract.identity,
  category: verifiedSessionRename.contract.category,
  slash: {
    name: verifiedSessionRename.contract.path[0],
    aliases: verifiedSessionRename.contract.aliases.flatMap((alias) => alias[0] ?? []),
  },
} as const
