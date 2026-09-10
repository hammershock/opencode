export * as SkillSettings from "./settings"

import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from "jsonc-parser"
import { Skill } from "@opencode-ai/schema/skill"
import { Context, Effect, Layer, Schema } from "effect"
import { makeGlobalNode } from "../effect/app-node"
import { Flock } from "../util/flock"
import { Global } from "../global"
import { TargetRegistry } from "../target-registry"
import { SkillRegistry } from "./registry"
import { AbsolutePath } from "../schema"

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "SkillSettings.RevisionConflictError",
  { expected: Skill.Digest, actual: Skill.Digest },
) {}

export class InvalidConfigError extends Schema.TaggedErrorClass<InvalidConfigError>()(
  "SkillSettings.InvalidConfigError",
  { diagnostics: Schema.Array(Skill.SettingsDiagnostic) },
) {}

export class InvalidPathError extends Schema.TaggedErrorClass<InvalidPathError>()("SkillSettings.InvalidPathError", {
  path: Schema.String,
}) {}

export class InvalidUrlError extends Schema.TaggedErrorClass<InvalidUrlError>()("SkillSettings.InvalidUrlError", {
  url: Schema.String,
}) {}

export interface Interface {
  readonly load: () => Promise<Skill.SettingsSnapshot>
  readonly updateDiscovery: (input: Skill.DiscoveryUpdate) => Promise<Skill.SettingsSnapshot>
  readonly resetDiscovery: (expectedRevision: Skill.Digest) => Promise<Skill.SettingsSnapshot>
  readonly updateTargetScope: (
    skillID: Skill.ID,
    scope: Skill.TargetScope,
    expectedRevision: Skill.Digest,
  ) => Promise<Skill.SettingsSnapshot>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillSettings") {}

type ConfigFile = {
  readonly path: string
  readonly text: string
  readonly exists: boolean
  readonly value?: Record<string, unknown>
}

type Decoded = {
  readonly paths: readonly string[]
  readonly urls: readonly string[]
  readonly targets: Readonly<Record<string, Skill.TargetScope>>
  readonly diagnostics: readonly Skill.SettingsDiagnostic[]
}

export function make(options: {
  readonly directory: string
  readonly home: string
  readonly targetIDs?: () => Promise<ReadonlySet<string>>
  readonly invalidate?: () => Promise<void>
}): Interface {
  const files = [path.join(options.directory, "opencode.json"), path.join(options.directory, "opencode.jsonc")]

  const read = async () => {
    const configs = await Promise.all(files.map(readConfig))
    const source = configs.findLast((config) => config.value && Object.hasOwn(config.value, "skills"))
    const decoded = decode(source?.value?.skills)
    const targetIDs = await options.targetIDs?.().catch(() => new Set<string>())
    const diagnostics = [
      ...configs.flatMap((config) => configDiagnostics(config)),
      ...decoded.diagnostics,
      ...Object.entries(decoded.targets).flatMap(([skillID, scope]) =>
        scope === "*"
          ? []
          : scope.flatMap((target) => {
              if (target === "local" || targetIDs === undefined || targetIDs.has(target)) return []
              return [
                Skill.SettingsDiagnostic.make({
                  kind: "missing-target",
                  severity: "warning",
                  field: `skills.targets.${skillID}`,
                  message: "Configured target is missing on this device",
                  skillID: Skill.ID.make(skillID),
                  targetID: target,
                }),
              ]
            }),
      ),
    ]
    const roots = await discoveryRoots(options.directory, options.home, source?.path, decoded, diagnostics)
    diagnostics.sort(compareDiagnostic)
    return Skill.SettingsSnapshot.make({
      path: AbsolutePath.make(pathForMutation(configs)),
      revision: revision(configs),
      roots,
      targets: decoded.targets,
      diagnostics,
      valid: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
    })
  }

  const mutate = async (
    expectedRevision: Skill.Digest,
    update: (text: string, snapshot: Skill.SettingsSnapshot) => string,
  ) =>
    Flock.withLock(`skill-settings:${options.directory}`, async () => {
      const before = await read()
      if (before.revision !== expectedRevision)
        throw new RevisionConflictError({ expected: expectedRevision, actual: before.revision })
      if (!before.valid) throw new InvalidConfigError({ diagnostics: before.diagnostics })
      const text = await readText(before.path)
      await atomicWrite(before.path, update(text, before))
      await options.invalidate?.()
      return read()
    })

  return {
    load: read,
    async updateDiscovery(input) {
      const paths = await normalizePaths(input.paths, options.directory, options.home)
      const urls = normalizeUrls(input.urls)
      return mutate(input.expectedRevision, (text, snapshot) =>
        editDiscovery(text, { paths, urls, targets: snapshot.targets }),
      )
    },
    async resetDiscovery(expectedRevision) {
      return mutate(expectedRevision, (text, snapshot) =>
        editDiscovery(text, { paths: [], urls: [], targets: snapshot.targets }),
      )
    },
    async updateTargetScope(skillID, scope, expectedRevision) {
      const normalized = normalizeScope(scope)
      return mutate(expectedRevision, (text, snapshot) => editTargetScope(text, snapshot, skillID, normalized))
    },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const targets = yield* TargetRegistry.Service
    const registry = yield* SkillRegistry.Service
    return Service.of(
      make({
        directory: global.config,
        home: global.home,
        targetIDs: async () => new Set((await targets.load()).targets.map((target) => target.id)),
        invalidate: () => Effect.runPromise(registry.invalidate()),
      }),
    )
  }),
)

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [Global.node, TargetRegistry.node, SkillRegistry.node],
})

async function readConfig(filepath: string): Promise<ConfigFile> {
  const text = await fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  if (text === undefined) return { path: filepath, text: "", exists: false }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  if (errors.length || !isRecord(value)) return { path: filepath, text, exists: true }
  return { path: filepath, text, exists: true, value }
}

function configDiagnostics(config: ConfigFile) {
  if (!config.exists) return []
  const errors: ParseError[] = []
  const value: unknown = parse(config.text, errors, { allowTrailingComma: true })
  if (!errors.length && isRecord(value)) return []
  return (errors.length ? errors : [{ error: 1, offset: 0, length: 0 }]).map((error) =>
    Skill.SettingsDiagnostic.make({
      kind: "invalid-config",
      severity: "error",
      field: config.path,
      message: errors.length ? printParseErrorCode(error.error) : "Configuration root must be an object",
    }),
  )
}

function decode(input: unknown): Decoded {
  if (input === undefined) return { paths: [], urls: [], targets: {}, diagnostics: [] }
  if (Array.isArray(input)) {
    const values = input.filter((value): value is string => typeof value === "string")
    const diagnostics =
      values.length === input.length
        ? []
        : [invalidConfig("skills", "Legacy Skill source list must contain only strings")]
    return {
      paths: values.filter((value) => !isHttpUrl(value)),
      urls: values.filter(isHttpUrl),
      targets: {},
      diagnostics,
    }
  }
  if (!isRecord(input))
    return {
      paths: [],
      urls: [],
      targets: {},
      diagnostics: [invalidConfig("skills", "Skill settings must be an object")],
    }

  const paths = decodeStrings(input.paths, "skills.paths")
  const urls = decodeStrings(input.urls, "skills.urls")
  const targets = decodeTargets(input.targets)
  return {
    paths: paths.values,
    urls: urls.values,
    targets: targets.values,
    diagnostics: [...paths.diagnostics, ...urls.diagnostics, ...targets.diagnostics],
  }
}

function decodeStrings(input: unknown, field: string) {
  if (input === undefined) return { values: [] as string[], diagnostics: [] as Skill.SettingsDiagnostic[] }
  if (!Array.isArray(input) || input.some((value) => typeof value !== "string"))
    return { values: [] as string[], diagnostics: [invalidConfig(field, "Value must be an array of strings")] }
  return { values: input, diagnostics: [] as Skill.SettingsDiagnostic[] }
}

function decodeTargets(input: unknown) {
  if (input === undefined)
    return { values: {} as Record<string, Skill.TargetScope>, diagnostics: [] as Skill.SettingsDiagnostic[] }
  if (!isRecord(input))
    return {
      values: {} as Record<string, Skill.TargetScope>,
      diagnostics: [invalidConfig("skills.targets", "Target scopes must be an object")],
    }
  return Object.entries(input).reduce(
    (result, [skillID, scope]) => {
      if (!/^skl_[0-9a-f]{64}$/.test(skillID) || !validScope(scope)) {
        result.diagnostics.push(invalidConfig(`skills.targets.${skillID}`, "Target scope is invalid"))
        return result
      }
      result.values[skillID] = normalizeScope(scope)
      return result
    },
    { values: {} as Record<string, Skill.TargetScope>, diagnostics: [] as Skill.SettingsDiagnostic[] },
  )
}

async function discoveryRoots(
  directory: string,
  home: string,
  source: string | undefined,
  decoded: Decoded,
  diagnostics: Skill.SettingsDiagnostic[],
) {
  const defaults = [path.join(directory, "skill"), path.join(directory, "skills")]
  const configured = await normalizePathsForRead(
    decoded.paths,
    source ? path.dirname(source) : directory,
    home,
    diagnostics,
  )
  const unique = new Map<string, Skill.DiscoveryRoot>()
  for (const root of defaults) unique.set(root, await filesystemRoot("opencode-global", root, true))
  for (const root of configured) {
    if (unique.has(root.resolved)) {
      diagnostics.push(
        Skill.SettingsDiagnostic.make({
          kind: "duplicate-root",
          severity: "warning",
          field: "skills.paths",
          message: "Configured path duplicates an existing discovery root",
        }),
      )
      continue
    }
    unique.set(
      root.resolved,
      Skill.DiscoveryRoot.make({
        kind: "imported",
        value: root.value,
        resolved: AbsolutePath.make(root.resolved),
        default: false,
        status: await filesystemStatus(root.resolved),
      }),
    )
  }
  const urls: string[] = []
  for (const value of decoded.urls) {
    if (!isHttpUrl(value)) {
      diagnostics.push(
        Skill.SettingsDiagnostic.make({
          kind: "invalid-url",
          severity: "error",
          field: "skills.urls",
          message: "Configured Skill URL must use HTTP or HTTPS",
        }),
      )
      continue
    }
    const normalized = new URL(value).toString()
    if (urls.includes(normalized)) {
      diagnostics.push(
        Skill.SettingsDiagnostic.make({
          kind: "duplicate-root",
          severity: "warning",
          field: "skills.urls",
          message: "Configured URL is duplicated",
        }),
      )
      continue
    }
    urls.push(normalized)
  }
  return [
    ...unique.values(),
    ...urls.map((url) => Skill.DiscoveryRoot.make({ kind: "url", value: url, default: false, status: "configured" })),
  ]
}

async function filesystemRoot(kind: "opencode-global" | "imported", root: string, defaultRoot: boolean) {
  const status = await filesystemStatus(root)
  return Skill.DiscoveryRoot.make({
    kind,
    value: root,
    resolved: AbsolutePath.make(root),
    default: defaultRoot,
    status,
  })
}

async function filesystemStatus(root: string) {
  return fs
    .stat(root)
    .then((value) => (value.isDirectory() ? ("ready" as const) : ("unavailable" as const)))
    .catch(() => "unavailable" as const)
}

async function normalizePathsForRead(
  values: readonly string[],
  directory: string,
  home: string,
  diagnostics: Skill.SettingsDiagnostic[],
) {
  const roots: Array<{ value: string; resolved: string }> = []
  for (const value of values) {
    try {
      const root = await normalizePath(value, directory, home)
      if (!roots.some((item) => item.resolved === root)) roots.push({ value, resolved: root })
      else
        diagnostics.push(
          Skill.SettingsDiagnostic.make({
            kind: "duplicate-root",
            severity: "warning",
            field: "skills.paths",
            message: "Configured path is duplicated",
          }),
        )
    } catch {
      diagnostics.push(
        Skill.SettingsDiagnostic.make({
          kind: "invalid-path",
          severity: "error",
          field: "skills.paths",
          message: "Configured Skill path is invalid",
        }),
      )
    }
  }
  return roots
}

async function normalizePaths(values: readonly string[], directory: string, home: string) {
  const roots: string[] = []
  for (const value of values) {
    const root = await normalizePath(value, directory, home).catch(() => {
      throw new InvalidPathError({ path: value })
    })
    if (!roots.includes(root)) roots.push(root)
  }
  return roots
}

async function normalizePath(value: string, directory: string, home: string) {
  if (!value.trim() || value !== value.trim() || /\u0000/.test(value)) throw new Error("invalid path")
  const expanded = value === "~" ? home : value.startsWith("~/") ? path.join(home, value.slice(2)) : value
  const resolved = path.resolve(directory, expanded)
  return fs.realpath(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return resolved
    throw error
  })
}

function normalizeUrls(values: readonly string[]) {
  return Array.from(
    new Set(
      values.map((value) => {
        if (!isHttpUrl(value)) throw new InvalidUrlError({ url: value })
        return new URL(value).toString()
      }),
    ),
  )
}

function normalizeScope(scope: Skill.TargetScope) {
  if (scope === "*") return scope
  return Array.from(new Set(scope))
}

function validScope(input: unknown): input is Skill.TargetScope {
  if (input === "*") return true
  return Array.isArray(input) && input.every((value) => value === "local" || isTargetID(value))
}

function isTargetID(input: unknown): input is Skill.Target {
  return (
    typeof input === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input)
  )
}

function isHttpUrl(value: string) {
  if (!URL.canParse(value)) return false
  return /^(https?:)$/.test(new URL(value).protocol)
}

function invalidConfig(field: string, message: string) {
  return Skill.SettingsDiagnostic.make({ kind: "invalid-config", severity: "error", field, message })
}

function configuredPaths(snapshot: Skill.SettingsSnapshot) {
  return snapshot.roots.filter((root) => root.kind === "imported").map((root) => root.value)
}

function configuredUrls(snapshot: Skill.SettingsSnapshot) {
  return snapshot.roots.filter((root) => root.kind === "url").map((root) => root.value)
}

function editDiscovery(
  text: string,
  settings: { paths: readonly string[]; urls: readonly string[]; targets: Readonly<Record<string, Skill.TargetScope>> },
) {
  const base = text.trim() ? text : "{}\n"
  const parsed: unknown = parse(base, [], { allowTrailingComma: true })
  if (!isRecord(parsed) || !isRecord(parsed.skills))
    return edit(base, ["skills"], {
      paths: settings.paths,
      urls: settings.urls,
      ...(Object.keys(settings.targets).length ? { targets: settings.targets } : {}),
    })
  const paths = edit(base, ["skills", "paths"], settings.paths)
  return edit(paths, ["skills", "urls"], settings.urls)
}

function editTargetScope(text: string, snapshot: Skill.SettingsSnapshot, skillID: Skill.ID, scope: Skill.TargetScope) {
  const base = text.trim() ? text : "{}\n"
  const parsed: unknown = parse(base, [], { allowTrailingComma: true })
  if (isRecord(parsed) && isRecord(parsed.skills)) return edit(base, ["skills", "targets", skillID], scope)
  return edit(base, ["skills"], {
    paths: configuredPaths(snapshot),
    urls: configuredUrls(snapshot),
    targets: { ...snapshot.targets, [skillID]: scope },
  })
}

function edit(text: string, jsonPath: readonly (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, [...jsonPath], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
}

function pathForMutation(configs: readonly ConfigFile[]) {
  return configs.findLast((config) => config.exists)?.path ?? configs[1]!.path
}

function revision(configs: readonly ConfigFile[]) {
  return Skill.Digest.make(
    createHash("sha256")
      .update(configs.map((config) => `${path.basename(config.path)}\u0000${config.text}`).join("\u0000"))
      .digest("hex"),
  )
}

async function readText(filepath: string) {
  return fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "{}\n"
    throw error
  })
}

async function atomicWrite(filepath: string, text: string) {
  await fs.mkdir(path.dirname(filepath), { recursive: true, mode: 0o700 })
  const previous = await fs.stat(filepath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined
    throw error
  })
  const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  try {
    await fs.writeFile(temporary, text, { mode: previous ? previous.mode & 0o777 : 0o600 })
    if (previous) await fs.chmod(temporary, previous.mode & 0o777)
    await fs.rename(temporary, filepath)
  } finally {
    await fs.unlink(temporary).catch(() => undefined)
  }
}

function compareDiagnostic(a: Skill.SettingsDiagnostic, b: Skill.SettingsDiagnostic) {
  return a.field.localeCompare(b.field) || a.kind.localeCompare(b.kind) || a.message.localeCompare(b.message)
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
}
