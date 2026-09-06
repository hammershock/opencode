export * as TargetWizard from "./target-wizard"

import { Location } from "./location"
import type { TargetRegistry } from "./target-registry"

export type Step = "name" | "connection" | "workspace" | "host-key" | "verification" | "review"

export type Draft = {
  readonly id: Location.TargetID
  readonly mode: "create" | "edit" | "restore"
  readonly name?: string
  readonly connection?: TargetRegistry.Connection
  readonly workspaceRoots: readonly string[]
  readonly defaultDirectory?: string
  readonly hostKeyPolicyAcknowledged: boolean
  readonly verification?: TargetRegistry.ProbeResult
  readonly command?: { readonly program: string; readonly args: readonly string[] }
  readonly saveDisposition?: "verified" | "unverified-confirmed"
}

export type State = {
  readonly step: Step
  readonly draft: Draft
  readonly warning?: string
}

export function create(mode: Draft["mode"] = "create", targetID?: Location.TargetID): State {
  return {
    step: "name",
    draft: {
      id: targetID ?? Location.TargetID.make(crypto.randomUUID()),
      mode,
      workspaceRoots: ["/"],
      hostKeyPolicyAcknowledged: false,
    },
    warning: "Workspace root / grants Rexd the widest filesystem scope; it is not a shell sandbox.",
  }
}

export function edit(target: TargetRegistry.Definition): State {
  return {
    step: "name",
    draft: {
      id: target.id,
      mode: "edit",
      name: target.name,
      connection: target.connection,
      workspaceRoots: target.workspaceRoots,
      defaultDirectory: target.defaultDirectory,
      command: target.command,
      hostKeyPolicyAcknowledged: false,
    },
  }
}

export function update(state: State, patch: Partial<Omit<Draft, "id" | "mode">>): State {
  const draft = {
    ...state.draft,
    ...patch,
  }
  return {
    ...state,
    draft,
    warning: draft.workspaceRoots.includes("/")
      ? "Workspace root / grants Rexd the widest filesystem scope; it is not a shell sandbox."
      : undefined,
  }
}

export function confirmUnverified(state: State): State {
  return state
}

export function next(state: State): State {
  const order: readonly Step[] = ["name", "connection", "workspace", "host-key", "verification", "review"]
  const problem = validateStep(state)
  if (problem) return { ...state, warning: problem }
  return { ...state, step: order[Math.min(order.indexOf(state.step) + 1, order.length - 1)] }
}

export function previous(state: State): State {
  const order: readonly Step[] = ["name", "connection", "workspace", "host-key", "verification", "review"]
  return { ...state, step: order[Math.max(order.indexOf(state.step) - 1, 0)] }
}

export function input(state: State): TargetRegistry.Input | undefined {
  if (!state.draft.name || !state.draft.connection || !state.draft.workspaceRoots.length) return
  return {
    name: state.draft.name,
    transport: "ssh",
    connection: state.draft.connection,
    workspaceRoots: state.draft.workspaceRoots,
    defaultDirectory: state.draft.defaultDirectory,
    command: state.draft.command,
  }
}

function validateStep(state: State) {
  if (state.step === "name" && !state.draft.name?.trim()) return "Enter a target name."
  if (state.step === "connection" && !state.draft.connection) return "Choose an SSH connection."
  if (state.step === "workspace" && !state.draft.workspaceRoots.length) return "Enter at least one workspace root."
  if (state.step === "host-key" && !state.draft.hostKeyPolicyAcknowledged)
    return "Review the host identity policy. Unknown host keys are never accepted automatically."
  if (state.step === "verification" && !state.draft.verification) return "Test or prepare the target before continuing."
}
