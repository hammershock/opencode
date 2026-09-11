import path from "path"
import type {
  SkillDiscoveryRoot,
  SkillMetadata,
  SkillRegistrySnapshot,
  SkillSettingsSnapshot,
  SkillTargetScope,
} from "@opencode-ai/sdk/v2"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal } from "solid-js"
import { useSDK } from "../context/sdk"
import { useTheme } from "../context/theme"
import { useDialog } from "../ui/dialog"
import { DialogConfirm } from "../ui/dialog-confirm"
import { DialogPrompt } from "../ui/dialog-prompt"
import { DialogSelect, displayTruncate, type DialogSelectOption } from "../ui/dialog-select"
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
  readonly skill?: {
    readonly source: string
    readonly targets: string
    readonly state: "active" | "inactive" | "undetected"
  }
}

export function skillRootStatus(root: SkillDiscoveryRoot) {
  if (root.status === "undetected") return "! undetected"
  if (root.status === "unavailable") return "! unavailable"
  if (root.default) return "● default"
  if (root.status === "configured") return "○ configured"
  return "● ready"
}

export function skillScopeLabel(scope: SkillTargetScope | undefined) {
  if (scope === undefined || scope === "*") return "all"
  if (scope.length === 0) return "none"
  return scope.join(", ")
}

export function toggleSkillTargetScope(
  scope: SkillTargetScope,
  target: "local" | string,
  targets: readonly string[] = [target],
): SkillTargetScope {
  if (scope === "*") return targets.filter((item) => item !== target)
  if (scope.includes(target)) return scope.filter((item) => item !== target)
  return [...scope, target]
}

export function skillSourceLabel(sourceLabel: string) {
  const source = sourceLabel.replace(/ · [0-9a-f]{8}$/i, "").toLowerCase()
  if (source === "built-in" || source.startsWith("opencode ") || source.startsWith("project .opencode"))
    return "opencode"
  if (source === "codex") return "codex"
  if (source === "claude") return "claude"
  return "others"
}

export function skillTargetsLabel(scope: SkillTargetScope | undefined, targets: readonly SkillManagerTarget[]) {
  if (scope === undefined || scope === "*") return "all"
  if (scope.length === 0) return "none"
  return scope
    .map((targetID) => {
      if (targetID === "local") return "local"
      return targets.find((target) => target.id === targetID)?.name ?? `missing:${targetID.slice(0, 8)}`
    })
    .join(", ")
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
        name: `Undetected Skill · ${skillID.slice(4, 12)}`,
        sourceLabel: "Other",
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
        root.kind === "opencode-global" ? "opencode" : root.kind === "url" ? "others" : rootSourceLabel(root, home),
      footer: skillRootStatus(root),
      category: "Discovery paths",
      inspectTitle: true,
      inspectionTitle: root.resolved ?? root.value,
    })),
    ...[...skills.values(), ...dormant]
      .toSorted((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
      .map((skill) => {
        const scope = targetScope(model.settings, skill.id)
        const undetected = !skills.has(skill.id)
        return {
          key: `skill:${skill.id}`,
          title: skill.name,
          details: duplicateNames.has(skill.name) ? ["Duplicate name · source identity is preserved"] : undefined,
          category: "Skills",
          skill: {
            source: skillSourceLabel(skill.sourceLabel),
            targets: skillTargetsLabel(scope, model.targets),
            state: undetected
              ? ("undetected" as const)
              : scope === "*" || scope.length > 0
                ? ("active" as const)
                : ("inactive" as const),
          },
        }
      }),
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
  const dimensions = useTerminalDimensions()
  const { theme } = useTheme()
  const [model, setModel] = createSignal<SkillManagerModel>()
  const [loading, setLoading] = createSignal(false)
  const home = process.env.HOME

  const read = async (force: boolean) => {
    const settings = await sdk.client.v2.skill.settings({ throwOnError: true })
    const location = { directory: path.dirname(settings.data.path) }
    const [catalog, targets] = await Promise.allSettled([
      sdk.client.v2.skill.catalog(
        { location, forceReload: force ? "true" : "false", includeInactive: "true" },
        { throwOnError: true },
      ),
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
    const targetIDs = ["local", ...current.targets.map((target) => target.id)]
    const toggle = (value: string) => {
      if (value === "all") return setScope((current) => (current === "*" ? [] : "*"))
      setScope((current) => toggleSkillTargetScope(current, value.slice(7), targetIDs))
    }
    const apply = () => {
      if (loading()) return
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
    }
    const options = createMemo(() => [
      {
        title: `${scope() === "*" ? "[x]" : "[ ]"} all`,
        description: "Includes future targets",
        value: "all",
        category: "Targets",
        onSelect: () => toggle("all"),
      },
      targetOption("local", "local", scope(), toggle),
      ...current.targets.map((target) => targetOption(target.id, target.name, scope(), toggle)),
      ...missing().map((targetID) => ({
        title: `${scope() !== "*" && scope().includes(targetID) ? "[x]" : "[ ]"} missing:${targetID.slice(0, 8)}`,
        description: "The stable target ID is preserved",
        value: `target:${targetID}`,
        category: "Targets",
        onSelect: () => toggle(`target:${targetID}`),
      })),
    ])
    const Content = () => (
      <DialogSelect<string>
        title={`Target access · ${skill.name}`}
        options={options()}
        renderFilter={false}
        preserveSelection
        locked={loading()}
        footer={<TargetAccessFooter onConfirm={apply} />}
        onToggle={(option) => toggle(option.value)}
        onConfirm={apply}
      />
    )
    dialog.replace(Content)
    dialog.setSize("large")
  }

  const rows = createMemo(() => (model() ? buildSkillManagerRows(model()!, home) : []))
  const skillTitle = (name: string, skill: NonNullable<ManagerRow["skill"]>) => {
    const widths = skillColumnWidths(dimensions().width)
    return `${column(name, widths.name)} ${column(skill.source, widths.source)} ${column(skill.targets, widths.targets)}`
  }
  const skillHeader = () => {
    const widths = skillColumnWidths(dimensions().width)
    return (
      <text fg={theme.accent} attributes={TextAttributes.BOLD}>
        {column("Name", widths.name)} {column("Source", widths.source)} {column("Targets", widths.targets)} State
      </text>
    )
  }
  const options = createMemo(() =>
    rows().map(
      (row): DialogSelectOption<string> => ({
        title: row.skill ? skillTitle(row.title, row.skill) : row.title,
        titleWidth: row.skill ? skillTitleWidth(dimensions().width) : undefined,
        description: row.description,
        footer: row.skill ? (
          <span
            style={{
              fg:
                row.skill.state === "active"
                  ? theme.success
                  : row.skill.state === "undetected"
                    ? theme.warning
                    : theme.textMuted,
            }}
          >
            {skillStateLabel(row.skill.state)}
          </span>
        ) : (
          row.footer
        ),
        footerWidth: row.skill ? 12 : undefined,
        details: row.details,
        category: row.category,
        categoryView:
          row.skill && rows().find((item) => item.category === "Skills")?.key === row.key ? skillHeader() : undefined,
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
    dialog.setSize("xlarge")
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

function rootSourceLabel(root: SkillDiscoveryRoot, home?: string) {
  const value = path.resolve(root.resolved ?? root.value)
  const codex = path.resolve(process.env.CODEX_HOME?.trim() || path.join(home ?? "~", ".codex"), "skills")
  const claude = path.resolve(path.join(home ?? "~", ".claude", "skills"))
  if (value === codex || (path.basename(value) === "skills" && path.basename(path.dirname(value)) === ".codex"))
    return "codex"
  if (value === claude || (path.basename(value) === "skills" && path.basename(path.dirname(value)) === ".claude"))
    return "claude"
  return "others"
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

function targetOption(targetID: string, name: string, scope: SkillTargetScope, toggle: (value: string) => void) {
  const value = `target:${targetID}`
  return {
    title: `${scope === "*" || scope.includes(targetID) ? "[x]" : "[ ]"} ${name}`,
    description: targetID === "local" ? "This controller" : "Configured Rexd target",
    value,
    category: "Targets",
    onSelect: () => toggle(value),
  }
}

function unavailableSkill(skillID: string): SkillMetadata {
  return {
    id: skillID,
    name: `Undetected Skill · ${skillID.slice(4, 12)}`,
    sourceLabel: "Other",
    digest: "",
  }
}

function TargetAccessFooter(props: { onConfirm: () => void }) {
  const { theme } = useTheme()
  return (
    <text fg={theme.textMuted} onMouseUp={props.onConfirm}>
      <span style={{ fg: theme.text }}>[ Confirm ]</span> enter · space toggle
    </text>
  )
}

function skillStateLabel(state: "active" | "inactive" | "undetected") {
  if (state === "active") return "● active"
  if (state === "undetected") return "! undetected"
  return "○ inactive"
}

function skillColumnWidths(terminalWidth: number) {
  const available = Math.max(46, Math.min(104, terminalWidth - 14))
  const source = 10
  const state = 12
  const targets = Math.max(14, Math.min(36, Math.floor((available - source - state - 3) * 0.45)))
  return { name: Math.max(10, available - source - targets - state - 3), source, targets }
}

function skillTitleWidth(terminalWidth: number) {
  const widths = skillColumnWidths(terminalWidth)
  return widths.name + widths.source + widths.targets + 2
}

function column(value: string, width: number) {
  const visible = displayTruncate(value, width)
  return visible + " ".repeat(Math.max(0, width - Bun.stringWidth(visible)))
}

export type { ManagerRow, SkillManagerModel, SkillManagerTarget }
