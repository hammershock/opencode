import { defineUpstreamCommand, verifyUpstreamCommand } from "@opencode-ai/command-kit"

const reviewedSessionRename = defineUpstreamCommand(
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
)

const currentSessionRename = defineUpstreamCommand(
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
)

// This is intentionally evaluated by TypeScript, not discovered in production.
// Any source-side contract edit must update the reviewed baseline in the same PR.
export const verifiedSessionRename = verifyUpstreamCommand(reviewedSessionRename, currentSessionRename)

export const sessionRenameMetadata = {
  title: verifiedSessionRename.contract.title,
  value: verifiedSessionRename.contract.identity,
  category: verifiedSessionRename.contract.category,
  slash: {
    name: verifiedSessionRename.contract.path[0],
    aliases: verifiedSessionRename.contract.aliases.flatMap((alias) => alias[0] ?? []),
  },
} as const
