import { defineUpstreamCommand, verifyUpstreamCommand } from "@opencode-ai/command-kit"
import { verifiedAppExit } from "../../src/command-toolkit/upstream-app"

const drifted = defineUpstreamCommand(
  {
    ...verifiedAppExit.contract,
    aliases: [["quit"]],
  },
  verifiedAppExit.fingerprint,
)

// Static fixture: losing /q (or any other source contract change) must fail
// the build until the pinned upstream baseline is explicitly reviewed.
// @ts-expect-error current aliases differ from the reviewed contract
verifyUpstreamCommand(verifiedAppExit, drifted)
