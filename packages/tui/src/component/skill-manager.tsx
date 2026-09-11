import path from "path"
import type {
  SkillDiscoveryRoot,
  SkillMetadata,
  SkillRegistrySnapshot,
  SkillSettingsSnapshot,
  SkillTargetScope,
} from "@opencode-ai/sdk/v2"
import { createMemo, createSignal } from "solid-js"
import { useSDK } from "../context/sdk"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, type DialogSelectOption } from "../ui/dialog-select"
import { useToast } from "../ui/toast"
import { errorMessage } from "../util/error"
import { completeLocalDirectory } from "./location-directory-workflow"

type SkillManagerTarget = { readonly id: string; readonly name: string }

type SkillManagerModel = {
  readonly settings: SkillSettingsSnapshot
  readonly catalog: SkillRegistrySnapshot
  readonly targets: readonly SkillManagerTarget[]
  readonly catalogError?: string
  readonly targetError?: string
}

type ManagerRow = {
  readonly key: string
  readonly title: string
  readonly description?: string
  readonly footer?: string
  readonly details?: string[]
  readonly category: string
  readonly inspectTitle?: boolean
  readonly inspectionTitle?: string
}

export function skillRootStatus(root: SkillDiscoveryRoot) {
  if (root.status === "unavailable") return "! unavailable"
  if (root.default) return "● default"
  if (root.status === "configured") return "○ configured"
  return "● ready"
}

export function skillScopeLabel(scope: SkillTargetScope | undefined) {
  if (scope === undefined || scope === "*") return "all targets"
  if (scope.length === 0) return "disabled"
  if (scope.length === 1 && scope[0] === "local") return "local only"
  return `${scope.length} ${scope.length === 1 ? "target" : "targets"}`
}

export function toggleSkillTargetScope(scope: SkillTargetScope, target: "local" | string): SkillTargetScope {
  if (scope === "*") return [target]
  if (scope.includes(target)) return scope.filter((item) => item !== target)
  return [...scope, target]
}

export function buildSkillManagerRows(model: SkillManagerModel, home?: string): ManagerRow[] {
  const duplicateNames = new Set(
    model.catalog.skills
      .filter((skill, index, skills) =>
        skills.some((item, itemIndex) => itemIndex !== index && item.name === skill.name),
      )
      .map((skill) => skill.name),
  )
  const skills = new Map(model.catalog.skills.map((skill) => [skill.id, skill]))
  const dormant = Object.keys(model.settings.targets)
    .filter((skillID) => !skills.has(skillID))
    .map(
      (skillID): SkillMetadata => ({
        id: skillID,
        name: `Unavailable Skill · ${skillID.slice(4, 12)}`,
        sourceLabel: "Dormant target access",
        digest: "",
      }),
    )
  const diagnostics = [
    ...model.settings.diagnostics.map((diagnostic) => ({ type: "settings" as const, diagnostic })),
    ...model.catalog.diagnostics.map((diagnostic) => ({ type: "catalog" as const, diagnostic })),
  ]
  const failures = [
    ...(model.catalogError
      ? [
          {
            key: "diagnostic:catalog-error",
            title: "Skill catalog",
            description: model.catalogError,
            footer: "! unavailable",
            category: "Diagnostics",
          },
        ]
      : []),
    ...(model.targetError
      ? [
          {
            key: "diagnostic:target-error",
            title: "Target registry",
            description: model.targetError,
            footer: "! unavailable",
            category: "Diagnostics",
          },
        ]
      : []),
  ]
  return [
    { key: "action:add", title: "Add path…", description: "Controller filesystem path", category: "Actions" },
    {
      key: "action:codex",
      title: "Import Codex skills",
      description: "Add the Codex user Skill directory",
      category: "Actions",
    },
    {
      key: "action:claude",
      title: "Import Claude skills",
      description: "Add the Claude user Skill directory",
      category: "Actions",
    },
    { key: "action:reload", title: "Reload catalog", description: "Rescan configured roots", category: "Actions" },
    {
      key: "action:reset",
      title: "Reset discovery paths",
      description: "Keep only OpenCode defaults without deleting files",
      category: "Actions",
    },
    ...model.settings.roots.map((root) => ({
      key: rootKey(root),
      title: rootTitle(root, home),
      description:
        root.kind === "opencode-global" ? "OpenCode config" : root.kind === "url" ? "Configured URL" : "Imported path",
      footer: skillRootStatus(root),
      category: "Discovery paths",
      inspectTitle: true,
      inspectionTitle: root.resolved ?? root.value,
    })),
    ...[...skills.values(), ...dormant]
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((skill) => ({
        key: `skill:${skill.id}`,
        title: skill.name,
        description: skill.sourceLabel,
        footer: skillScopeLabel(targetScope(model.settings, skill.id)),
        details: duplicateNames.has(skill.name) ? ["Duplicate name · source identity is preserved"] : undefined,
        category: "Skills",
      })),
    ...failures,
    ...diagnostics.slice(0, 20).map((item, index) => ({
      key: `diagnostic:${index}`,
      title: item.type === "settings" ? item.diagnostic.field : item.diagnostic.sourceLabel,
      description: item.diagnostic.message,
      footer: `! ${item.diagnostic.kind}`,
      category: "Diagnostics",
    })),
    ...(diagnostics.length > 20
      ? [
          {
            key: "diagnostic:more",
            title: `${diagnostics.length - 20} more diagnostics`,
            description: "Resolve visible issues or reload to refresh this bounded list",
            category: "Diagnostics",
          },
        ]
      : []),
  ]
}

export function useSkillManager() {
  const dialog = useDialog()
  const sdk = useSDK()
  const toast = useToast()
  const [model, setModel] = createSignal<SkillManagerModel>()
  const [loading, setLoading] = createSignal(false)
  const home = process.env.HOME

  const read = async (force: boolean) => {
    const settings = await sdk.client.v2.skill.settings({ throwOnError: true })
    const location = { directory: path.dirname(settings.data.path) }
    const [catalog, targets] = await Promise.allSettled([
      force
        ? sdk.client.v2.skill.reload({ location }, { throwOnError: true })
        : sdk.client.v2.skill.catalog({ location }, { throwOnError: true }),
      sdk.client.v2.target.list({ throwOnError: true }),
    ])
    return {
      settings: settings.data,
      catalog:
        catalog.status === "fulfilled"
          ? catalog.value.data.data
          : ({ revision: "", digest: "", skills: [], diagnostics: [] } satisfies SkillRegistrySnapshot),
      targets:
        targets.status === "fulfilled"
          ? targets.value.data.targets.map((target) => ({ id: target.id, name: target.name }))
          : [],
      ...(catalog.status === "rejected" ? { catalogError: errorMessage(catalog.reason) } : {}),
      ...(targets.status === "rejected" ? { targetError: errorMessage(targets.reason) } : {}),
    } satisfies SkillManagerModel
  }

  const refresh = async (force = false) => {
    const previous = model()?.catalog.digest
    setLoading(true)
    try {
      const next = await read(force)
      setModel(next)
      if (next.catalogError)
        toast.show({ title: "Skill catalog unavailable", message: next.catalogError, variant: "warning" })
      if (next.targetError) toast.show({ title: "Targets unavailable", message: next.targetError, variant: "warning" })
      if (force)
        toast.show({
          title: previous && previous !== next.catalog.digest ? "Skill catalog changed" : "Skill catalog unchanged",
          message: `${next.catalog.skills.length} Skills · ${next.catalog.diagnostics.length + next.settings.diagnostics.length} diagnostics`,
          variant: next.catalogError ? "warning" : "success",
        })
      return next
    } catch (error) {
      toast.show({ title: "Skill settings unavailable", message: errorMessage(error), variant: "error" })
    } finally {
      setLoading(false)
    }
  }

  const save = async (operation: (current: SkillManagerModel) => Promise<unknown>, title: string) => {
    const current = model()
    if (!current) return
    setLoading(true)
    try {
      await operation(current)
      const next = await read(true)
      setModel(next)
      toast.show({ title, message: "Saved locally · re-enter Sessions to apply", variant: "success" })
    } catch (error) {
      toast.show({ title: "Skill settings not saved", message: errorMessage(error), variant: "error" })
      const latest = await read(false).catch(() => undefined)
      if (latest) setModel(latest)
    } finally {
      setLoading(false)
    }
  }

  const addPath = async (preset?: "codex" | "claude") => {
    const current = model()
    if (!current) return
    const configDirectory = path.dirname(current.settings.path)
    const fallbackHome = home ?? "~"
    const initial =
      preset === "codex"
        ? path.join(process.env.CODEX_HOME?.trim() || path.join(fallbackHome, ".codex"), "skills")
        : preset === "claude"
          ? path.join(fallbackHome, ".claude", "skills")
          : undefined
    const value = await DialogPrompt.show(
      dialog,
      preset ? `Import ${preset === "codex" ? "Codex" : "Claude"} skills` : "Add Skill path",
      {
        value: initial,
        placeholder: initial ?? configDirectory,
        description: () => <text>Controller directory. Press Tab to complete local paths.</text>,
        complete: (input, cursor) =>
          completeLocalDirectory({ sdk, home: fallbackHome, value: input, cursor, cwd: configDirectory }).catch(() => ({
            value: input,
            cursor,
            candidates: [],
          })),
      },
    )
    if (value === null) return open()
    if (!value.trim()) return open()
    await save(
      (snapshot) =>
        sdk.client.v2.skill.discovery.update(
          {
            skillDiscoveryUpdate: {
              paths: [...importedPaths(snapshot.settings), value.trim()],
              urls: configuredUrls(snapshot.settings),
              expectedRevision: snapshot.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      "Discovery path added",
    )
    open(false)
  }

  const removeRoot = async (root: SkillDiscoveryRoot) => {
    const confirmed = await DialogConfirm.show(
      dialog,
      "Remove discovery path?",
      `Remove ${rootTitle(root, home)} from discovery? The Skill files remain untouched.`,
      undefined,
      { confirmLabel: "Remove path" },
    )
    if (!confirmed) return open()
    await save(
      (snapshot) =>
        sdk.client.v2.skill.discovery.update(
          {
            skillDiscoveryUpdate: {
              paths: importedPaths(snapshot.settings).filter((value) => root.kind === "url" || value !== root.value),
              urls: configuredUrls(snapshot.settings).filter((value) => root.kind !== "url" || value !== root.value),
              expectedRevision: snapshot.settings.revision,
            },
          },
          { throwOnError: true },
        ),
      "Discovery path removed",
    )
    open(false)
  }

  const reset = async () => {
    const current = model()
    if (!current) return
    const paths = importedPaths(current.settings).length
    const urls = configuredUrls(current.settings).length
    const confirmed = await DialogConfirm.show(
      dialog,
      "Reset discovery paths?",
      `Remove ${paths} imported ${paths === 1 ? "path" : "paths"} and ${urls} configured ${urls === 1 ? "URL" : "URLs"}? Skill files and target access settings remain untouched.`,
      undefined,
      { confirmLabel: "Reset paths" },
    )
    if (!confirmed) return open()
    await save(
      (snapshot) =>
        sdk.client.v2.skill.discovery.reset(
          { skillRevisionInput: { expectedRevision: snapshot.settings.revision } },
          { throwOnError: true },
        ),
      "Discovery paths reset",
    )
    open(false)
  }

  const showRoot = (root: SkillDiscoveryRoot) => {
    if (root.default) {
      toast.show({
        title: "OpenCode default",
        message: "Default discovery roots cannot be removed",
        variant: "warning",
      })
      return
    }
    dialog.replace(() => (
      <DialogSelect
        title={rootTitle(root, home)}
        options={[
          {
            title: "Remove path from discovery",
            description: "The Skill files remain untouched",
            value: "remove",
          },
        ]}
        onSelect={() => void removeRoot(root)}
      />
    ))
  }

  const showTargetAccess = (skill: SkillMetadata) => {
    const current = model()
    if (!current) return
    const [scope, setScope] = createSignal(targetScope(current.settings, skill.id))
    const missing = createMemo(() => {
      const value = scope()
      if (value === "*") return []
      return value.filter(
        (target) => target !== "local" && !current.targets.some((configured) => configured.id === target),
      )
    })
    const options = createMemo(() => [
      {
        title: "Save target access",
        description: "Device-local setting; active Sessions are unchanged",
        footer: skillScopeLabel(scope()),
        value: "save",
        category: "Actions",
      },
      {
        title: "All targets",
        description: "Includes future targets",
        footer: scope() === "*" ? "● allowed" : "○ explicit list",
        value: "all",
        category: "Target access",
      },
      targetOption("local", "Local", scope()),
      ...current.targets.map((target) => targetOption(target.id, target.name, scope())),
      ...missing().map((targetID) => ({
        title: `Missing target · ${targetID}`,
        description: "The stable target ID is preserved",
        footer: "! missing · allowed",
        value: `target:${targetID}`,
        category: "Target access",
      })),
    ])
    const Content = () => (
      <DialogSelect<string>
        title={`Target access · ${skill.name}`}
        options={options()}
        preserveSelection
        footer={<text>Selecting one target switches from All targets to an explicit list.</text>}
        onSelect={(option) => {
          if (option.value === "all") return setScope("*")
          if (option.value !== "save") return setScope((value) => toggleSkillTargetScope(value, option.value.slice(7)))
          void save(
            (snapshot) =>
              sdk.client.v2.skill.targetScope.update(
                {
                  skillID: skill.id,
                  skillTargetScopeUpdate: { scope: scope(), expectedRevision: snapshot.settings.revision },
                },
                { throwOnError: true },
              ),
            "Target access saved",
          ).then(() => open(false))
        }}
      />
    )
    dialog.replace(Content)
  }

  const rows = createMemo(() => (model() ? buildSkillManagerRows(model()!, home) : []))
  const options = createMemo(() =>
    rows().map(
      (row): DialogSelectOption<string> => ({
        title: row.title,
        description: row.description,
        footer: row.footer,
        details: row.details,
        category: row.category,
        inspectTitle: row.inspectTitle,
        inspectionTitle: row.inspectionTitle,
        value: row.key,
      }),
    ),
  )

  const select = (key: string) => {
    const current = model()
    if (!current) return
    if (key === "action:add") return void addPath()
    if (key === "action:codex") return void addPath("codex")
    if (key === "action:claude") return void addPath("claude")
    if (key === "action:reload") return void refresh(true)
    if (key === "action:reset") return void reset()
    if (key.startsWith("root:")) {
      const root = current.settings.roots.find((item) => rootKey(item) === key)
      if (root) return showRoot(root)
      return
    }
    if (!key.startsWith("skill:")) return
    const skillID = key.slice(6)
    const skill = current.catalog.skills.find((item) => item.id === skillID) ?? unavailableSkill(skillID)
    showTargetAccess(skill)
  }

  function open(load = true) {
    // DialogSelect owns navigation state. A controlled current/onMove pair recenters after
    // every key repeat and makes long Skill catalogs jump between queued scroll positions.
    dialog.replace(() => (
      <DialogSelect
        title="Manage skills"
        locked={loading()}
        preserveSelection
        options={options()}
        emptyView={<text>{loading() ? "Loading local Skill settings…" : "No Skill settings available"}</text>}
        footer={
          model() ? (
            <text>
              {model()!.settings.roots.length} paths · {model()!.catalog.skills.length} Skills ·{" "}
              {model()!.settings.diagnostics.length +
                model()!.catalog.diagnostics.length +
                Number(Boolean(model()!.catalogError)) +
                Number(Boolean(model()!.targetError))}{" "}
              diagnostics
            </text>
          ) : undefined
        }
        onSelect={(option) => select(option.value)}
      />
    ))
    if (load) void refresh()
  }

  return { open, refresh, model }
}

function rootTitle(root: SkillDiscoveryRoot, home?: string) {
  if (root.default) return `OpenCode config · ${path.basename(root.value)}`
  if (!home || (root.value !== home && !root.value.startsWith(home + path.sep))) return root.value
  return root.value === home ? "~" : `~${root.value.slice(home.length)}`
}

function rootKey(root: SkillDiscoveryRoot) {
  return `root:${root.kind}:${root.value}`
}

function targetScope(settings: SkillSettingsSnapshot, skillID: string): SkillTargetScope {
  const value = settings.targets[skillID]
  if (value === "*") return value
  if (Array.isArray(value) && value.every((target) => typeof target === "string")) return value
  return "*"
}

function importedPaths(settings: SkillSettingsSnapshot) {
  return settings.roots.filter((root) => root.kind === "imported").map((root) => root.value)
}

function configuredUrls(settings: SkillSettingsSnapshot) {
  return settings.roots.filter((root) => root.kind === "url").map((root) => root.value)
}

function targetOption(targetID: string, name: string, scope: SkillTargetScope) {
  return {
    title: name,
    description: targetID === "local" ? "This controller" : "Configured Rexd target",
    footer: scope !== "*" && scope.includes(targetID) ? "● allowed" : "○ blocked",
    value: `target:${targetID}`,
    category: "Target access",
  }
}

function unavailableSkill(skillID: string): SkillMetadata {
  return {
    id: skillID,
    name: `Unavailable Skill · ${skillID.slice(4, 12)}`,
    sourceLabel: "Dormant target access",
    digest: "",
  }
}

export type { ManagerRow, SkillManagerModel, SkillManagerTarget }
