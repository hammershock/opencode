import type { HomeSessionTarget } from "./session-destination"

export type TargetProbe =
  | { status: "ready"; stages: readonly string[] }
  | { status: "unavailable" | "invalid"; stage: string; message: string }

export type CandidateLocation = {
  target: { type: "local" } | { type: "rexd"; targetID: string }
  directory: string
  lastKnownTargetName?: string
}

export const executionTargetActions = [
  { title: "Add target…", value: "add" as const, category: "Actions" },
  { title: "Manage targets…", value: "manage" as const, category: "Actions" },
]

export function remoteInitialDirectory(target: { defaultDirectory?: string }, home: string) {
  return target.defaultDirectory ?? home
}

export function openExecutionTargetAction(action: "add" | "manage", open: (mode?: "manage" | "add") => void) {
  open(action)
}

export async function validateDestination(input: {
  target: HomeSessionTarget
  directory: string
  prepare: (targetID: string) => Promise<TargetProbe>
  validate: (location: CandidateLocation) => Promise<void>
}) {
  if (input.target.type === "rexd") {
    const result = await input.prepare(input.target.targetID)
    if (result.status !== "ready") throw new Error(`${result.stage}: ${result.message}`)
  }
  const location: CandidateLocation = {
    target: input.target.type === "local" ? { type: "local" } : { type: "rexd", targetID: input.target.targetID },
    directory: input.directory,
    ...(input.target.type === "rexd" ? { lastKnownTargetName: input.target.name } : {}),
  }
  await input.validate(location)
  return location
}
