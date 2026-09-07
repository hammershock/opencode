import { defineUpstreamCommand, verifyUpstreamCommand } from "@opencode-ai/command-kit"
import { currentUpstreamCommands } from "../../src/command-toolkit/upstream-current"
import { reviewedUpstreamCommands } from "../../src/command-toolkit/upstream-reviewed"

verifyUpstreamCommand(reviewedUpstreamCommands.appExit, currentUpstreamCommands.appExit)
verifyUpstreamCommand(reviewedUpstreamCommands.sessionRename, currentUpstreamCommands.sessionRename)

const inputDrift = defineUpstreamCommand(
  { ...currentUpstreamCommands.sessionRename.contract, inputBoundary: "optional-title" },
  currentUpstreamCommands.sessionRename.fingerprint,
)

// @ts-expect-error registration-consumed current metadata drift requires an explicit baseline review
verifyUpstreamCommand(reviewedUpstreamCommands.sessionRename, inputDrift)

const identityDrift = defineUpstreamCommand(
  { ...currentUpstreamCommands.sessionRename.contract, identity: "session.rename.changed" },
  currentUpstreamCommands.sessionRename.fingerprint,
)
// @ts-expect-error identity drift requires baseline review
verifyUpstreamCommand(reviewedUpstreamCommands.sessionRename, identityDrift)

const pathDrift = defineUpstreamCommand(
  { ...currentUpstreamCommands.sessionRename.contract, path: ["rename-changed"] },
  currentUpstreamCommands.sessionRename.fingerprint,
)
// @ts-expect-error slash path drift requires baseline review
verifyUpstreamCommand(reviewedUpstreamCommands.sessionRename, pathDrift)

const aliasDrift = defineUpstreamCommand(
  { ...currentUpstreamCommands.sessionRename.contract, aliases: [["name"]] },
  currentUpstreamCommands.sessionRename.fingerprint,
)
// @ts-expect-error alias drift requires baseline review
verifyUpstreamCommand(reviewedUpstreamCommands.sessionRename, aliasDrift)

const availabilityDrift = defineUpstreamCommand(
  { ...currentUpstreamCommands.sessionRename.contract, availability: "all-routes" },
  currentUpstreamCommands.sessionRename.fingerprint,
)
// @ts-expect-error availability drift requires baseline review
verifyUpstreamCommand(reviewedUpstreamCommands.sessionRename, availabilityDrift)
