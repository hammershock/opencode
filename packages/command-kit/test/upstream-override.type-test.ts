import { defineUpstreamCommand, verifyUpstreamCommand } from "../src"

const baseline = defineUpstreamCommand(
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

const drifted = defineUpstreamCommand(
  {
    identity: "session.rename",
    host: "tui.session",
    path: ["rename-session"],
    aliases: [],
    title: "Rename session",
    category: "Session",
    availability: "session-route",
    inputBoundary: "no-arguments",
  },
  "337fd144d2ba:session.rename:v1",
)

// This fixture proves that source contract drift is rejected by typecheck.
// @ts-expect-error the reviewed slash path and current registration differ
verifyUpstreamCommand(baseline, drifted)
