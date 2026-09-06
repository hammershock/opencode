import { DialogSelect } from "../ui/dialog-select"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogConfirm } from "../ui/dialog-confirm"
import type { DialogContext } from "../ui/dialog"

export type TargetDefinition = {
  id: string
  name: string
  connection:
    | { type: "ssh-config"; host: string }
    | { type: "manual"; host: string; user: string; port: number; identityFile?: string }
  workspaceRoots: string[]
  defaultDirectory?: string
  transport: "ssh"
  command?: { program: string; args: string[] }
}

export type TargetInput = Omit<TargetDefinition, "id">

type WizardServices = {
  inspect: (input: TargetInput) => Promise<{ home: string } | undefined>
  complete: (
    input: TargetInput,
    value: string,
    cursor: number,
    cwd: string,
  ) => Promise<{ value: string; cursor: number; candidates: string[] } | undefined>
}

export async function targetWizard(
  dialog: DialogContext,
  current?: TargetDefinition,
  services?: WizardServices,
): Promise<TargetInput | undefined> {
  const name = await DialogPrompt.show(dialog, current ? "Target name" : "Add target · name", {
    value: current?.name,
    placeholder: "gpu-server",
  })
  if (!name?.trim()) return
  const mode = await select(dialog, "SSH connection", [
    { title: "SSH Config host alias", value: "ssh-config" as const },
    { title: "Manual host, user and port", value: "manual" as const },
  ])
  if (!mode) return
  const host = await DialogPrompt.show(dialog, "SSH host", {
    value: current?.connection.host,
    placeholder: mode === "ssh-config" ? "my-server" : "server.example.com",
  })
  if (!host?.trim()) return
  const connection = await connectionInput(dialog, mode, host.trim(), current)
  if (!connection) return
  const draft = (workspaceRoots: string[], defaultDirectory?: string): TargetInput => ({
    name: name.trim(),
    transport: "ssh",
    connection,
    workspaceRoots,
    ...(defaultDirectory ? { defaultDirectory } : {}),
    ...(current?.command ? { command: current.command } : {}),
  })
  const inspected = current || !services ? undefined : await services.inspect(draft(["/"]))
  const roots = await DialogPrompt.show(dialog, "Workspace root", {
    value: current?.workspaceRoots.join(", ") ?? "/",
    description: () => (
      <text>Comma-separated absolute paths. “/” grants the widest filesystem scope and is not a shell sandbox.</text>
    ),
    ...(services
      ? {
          complete: (value: string, cursor: number) =>
            completeRoots(services, draft, value, cursor, inspected?.home ?? "/"),
        }
      : {}),
  })
  const workspaceRoots = roots
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean)
  if (!workspaceRoots?.length) return
  const defaultDirectory = await DialogPrompt.show(dialog, "Default working directory", {
    value: current?.defaultDirectory ?? inspected?.home,
    description: () => (
      <text>
        Initial directory for new Sessions. It must be inside a workspace root; the default is the remote HOME.
      </text>
    ),
    ...(services
      ? {
          complete: (value: string, cursor: number) =>
            services.complete(draft(workspaceRoots), value, cursor, inspected?.home ?? "/"),
        }
      : {}),
  })
  if (defaultDirectory === null) return
  const hostKey = await DialogConfirm.show(
    dialog,
    "Host identity policy",
    "OpenCode never accepts an unknown SSH host key automatically. Continue with this policy?",
  )
  if (!hostKey) return
  return {
    name: name.trim(),
    transport: "ssh",
    connection,
    workspaceRoots,
    ...(defaultDirectory.trim() ? { defaultDirectory: defaultDirectory.trim() } : {}),
    ...(current?.command ? { command: current.command } : {}),
  }
}

async function completeRoots(
  services: WizardServices,
  draft: (workspaceRoots: string[], defaultDirectory?: string) => TargetInput,
  value: string,
  cursor: number,
  cwd: string,
) {
  const start = value.lastIndexOf(",", cursor - 1) + 1
  const leading = value.slice(start, cursor).match(/^\s*/)?.[0] ?? ""
  const result = await services.complete(
    draft(["/"]),
    value.slice(start + leading.length),
    cursor - start - leading.length,
    cwd,
  )
  if (!result) return
  return {
    value: value.slice(0, start) + leading + result.value,
    cursor: start + leading.length + result.cursor,
    candidates: result.candidates,
  }
}

async function connectionInput(
  dialog: DialogContext,
  mode: "ssh-config" | "manual",
  host: string,
  current?: TargetDefinition,
): Promise<TargetInput["connection"] | undefined> {
  if (mode === "ssh-config") return { type: "ssh-config", host }
  const user = await DialogPrompt.show(dialog, "SSH user", {
    value: current?.connection.type === "manual" ? current.connection.user : undefined,
  })
  if (!user?.trim()) return
  const port = await DialogPrompt.show(dialog, "SSH port", {
    value: current?.connection.type === "manual" ? String(current.connection.port) : "22",
  })
  if (!port || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535) return
  const identityFile = await DialogPrompt.show(dialog, "Identity file (optional)", {
    value: current?.connection.type === "manual" ? current.connection.identityFile : undefined,
  })
  if (identityFile === null) return
  return {
    type: "manual",
    host,
    user: user.trim(),
    port: Number(port),
    ...(identityFile.trim() ? { identityFile: identityFile.trim() } : {}),
  }
}

function select<T>(dialog: DialogContext, title: string, options: { title: string; value: T }[]) {
  return new Promise<T | undefined>((resolve) =>
    dialog.replace(
      () => <DialogSelect title={title} options={options} onSelect={(option) => resolve(option.value)} />,
      () => resolve(undefined),
    ),
  )
}
