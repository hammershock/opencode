export * as SkillRegistry from "./registry"

import path from "path"
import { Context, Effect, Layer, Schema } from "effect"
import { Skill } from "@opencode-ai/schema/skill"
import { ConfigMarkdown } from "../config/markdown"
import { ControllerFileSystem } from "../controller-filesystem"
import { makeGlobalNode } from "../effect/app-node"
import { FSUtil } from "../fs-util"
import { AbsolutePath, RelativePath } from "../schema"
import { Hash } from "../util/hash"
import { SkillDiscovery } from "./discovery"

const Frontmatter = Schema.Struct({
  name: Schema.String.pipe(Schema.optional),
  description: Schema.String.pipe(Schema.optional),
  slash: Schema.Boolean.pipe(Schema.optional),
})
const decodeFrontmatter = Schema.decodeUnknownOption(Frontmatter)
const namePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface Entry {
  readonly metadata: Skill.Metadata
  readonly source: Skill.SourceDetail
  readonly sourceKey: string
  readonly location: AbsolutePath
  readonly content: string
  readonly slash?: boolean
}

export interface Result {
  readonly snapshot: Skill.RegistrySnapshot
  readonly entries: ReadonlyArray<Entry>
}

export interface LoadOptions {
  readonly forceReload?: boolean
}

export interface SourceOptions {
  readonly kind?: "opencode-global" | "opencode-project" | "imported"
  readonly label?: string
  readonly identity?: string
}

export interface Registration {
  readonly source: Skill.Source
  readonly options?: SourceOptions
}

export interface Interface {
  readonly load: (sources: ReadonlyArray<Registration>, options?: LoadOptions) => Effect.Effect<Result>
  readonly read: (entry: Entry) => Effect.Effect<Entry, ReadError>
  readonly invalidate: () => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SkillRegistry") {}

export class ReadError extends Schema.TaggedErrorClass<ReadError>()("SkillRegistry.ReadError", {
  skillID: Skill.ID,
  kind: Schema.Literals(["unavailable", "stale-catalog", "malformed"]),
}) {}

type SourceResult = {
  readonly entries: ReadonlyArray<Entry>
  readonly diagnostics: ReadonlyArray<Skill.Diagnostic>
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* ControllerFileSystem.Service
    const discovery = yield* SkillDiscovery.Service
    const cache = new Map<string, SourceResult>()

    const loadSource = Effect.fn("SkillRegistry.loadSource")(function* (
      registration: Registration,
      forceReload: boolean,
    ) {
      const sourceKey = key(registration)
      const cached = cache.get(sourceKey)
      if (cached && !forceReload) return cached

      const result =
        registration.source.type === "embedded"
          ? loadEmbedded(registration, registration.source)
          : registration.source.type === "directory"
            ? yield* loadDirectory(fs, registration, registration.source, registration.source.path)
            : yield* loadUrl(fs, discovery, registration, registration.source)
      cache.set(sourceKey, result)
      return result
    })

    return Service.of({
      invalidate: Effect.fn("SkillRegistry.invalidate")(function* () {
        cache.clear()
      }),
      load: Effect.fn("SkillRegistry.load")(function* (sources, options) {
        const unique = Array.from(
          new Map(sources.map((registration) => [key(registration), registration])).values(),
        ).toSorted((a, b) => key(a).localeCompare(key(b)))
        const loaded = yield* Effect.forEach(unique, (source) => loadSource(source, options?.forceReload ?? false), {
          concurrency: 4,
        })
        const byID = new Map(
          loaded
            .flatMap((item) => item.entries)
            .toSorted((a, b) => a.metadata.id.localeCompare(b.metadata.id))
            .map((entry) => [entry.metadata.id, entry]),
        )
        const entries = Array.from(byID.values()).toSorted(
          (a, b) => a.metadata.name.localeCompare(b.metadata.name) || a.metadata.id.localeCompare(b.metadata.id),
        )
        const duplicates = Map.groupBy(entries, (entry) => entry.metadata.name)
        const diagnostics = [
          ...loaded.flatMap((item) => item.diagnostics),
          ...Array.from(duplicates.entries()).flatMap(([name, matches]) => {
            if (matches.length < 2) return []
            return [
              Skill.Diagnostic.make({
                kind: "duplicate-name",
                severity: "warning",
                sourceLabel: "Registry",
                message: `Skill name "${name}" is ambiguous across ${matches.map((entry) => entry.metadata.sourceLabel).join(", ")}`,
              }),
            ]
          }),
        ].toSorted(compareDiagnostic)
        const skills = entries.map((entry) => entry.metadata)
        const digest = Skill.Digest.make(Hash.sha256(JSON.stringify({ skills, diagnostics })))

        return {
          entries,
          snapshot: Skill.RegistrySnapshot.make({ revision: digest, skills, diagnostics, digest }),
        }
      }),
      read: Effect.fn("SkillRegistry.read")(function* (entry) {
        if (entry.source.kind === "built-in") return entry
        const content = yield* fs
          .readFileStringSafe(entry.location)
          .pipe(Effect.mapError(() => new ReadError({ skillID: entry.metadata.id, kind: "unavailable" })))
        if (content === undefined) return yield* new ReadError({ skillID: entry.metadata.id, kind: "unavailable" })
        const markdown = ConfigMarkdown.parseOption(content)
        if (!markdown) return yield* new ReadError({ skillID: entry.metadata.id, kind: "malformed" })
        const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
        if (!frontmatter) return yield* new ReadError({ skillID: entry.metadata.id, kind: "malformed" })
        const name =
          frontmatter.name ??
          (path.basename(entry.location) === "SKILL.md" ? undefined : path.basename(entry.location, ".md"))
        if (
          name !== entry.metadata.name ||
          frontmatter.description !== entry.metadata.description ||
          frontmatter.slash !== entry.slash ||
          makeDigest(markdown.content) !== entry.metadata.digest
        )
          return yield* new ReadError({ skillID: entry.metadata.id, kind: "stale-catalog" })
        return { ...entry, content: markdown.content }
      }),
    })
  }),
)

function loadEmbedded(registration: Registration, source: Skill.EmbeddedSource): SourceResult {
  const identity = registration.options?.identity ?? `${source.skill.name}:${source.skill.location}`
  const id = makeID("built-in", identity, source.skill.name)
  const metadata = Skill.Metadata.make({
    id,
    name: source.skill.name,
    description: source.skill.description,
    sourceLabel: "Built-in",
    digest: makeDigest(source.skill.content),
  })
  return {
    entries: [
      {
        metadata,
        source: Skill.SourceDetail.make({ kind: "built-in", label: metadata.sourceLabel }),
        sourceKey: key(registration),
        location: source.skill.location,
        content: source.skill.content,
        slash: source.skill.slash,
      },
    ],
    diagnostics: [],
  }
}

const loadUrl = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  discovery: SkillDiscovery.Interface,
  registration: Registration,
  source: Skill.UrlSource,
) {
  const normalized = normalizeUrl(source.url)
  if (!normalized)
    return sourceFailure(
      "root-unavailable",
      registration.options?.label ?? "URL source",
      "Skill URL must use HTTP or HTTPS",
    )
  const directories = yield* discovery.pull(source.url)
  const loaded = yield* Effect.forEach(
    directories.toSorted(),
    (directory) =>
      loadDirectory(fs, registration, source, directory, {
        identityRoot: normalized,
        identityPrefix: path.basename(directory),
      }),
    { concurrency: 4 },
  )
  return {
    entries: loaded.flatMap((item) => item.entries),
    diagnostics: loaded.flatMap((item) => item.diagnostics),
  }
})

const loadDirectory = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  registration: Registration,
  source: Skill.DirectorySource | Skill.UrlSource,
  requestedRoot: string,
  identity?: { readonly identityRoot: string; readonly identityPrefix: string },
) {
  const kind = source.type === "url" ? ("url" as const) : (registration.options?.kind ?? "imported")
  const sourceLabel = sourceLabelFor(registration, source, kind)
  if (!(yield* fs.isDir(requestedRoot))) {
    return sourceFailure("root-unavailable", sourceLabel, `Skill root is unavailable: ${requestedRoot}`, requestedRoot)
  }

  const root = yield* fs.realPath(path.resolve(requestedRoot)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!root)
    return sourceFailure(
      "root-unavailable",
      sourceLabel,
      `Skill root cannot be resolved: ${requestedRoot}`,
      requestedRoot,
    )

  const matches = yield* fs
    .glob("{*.md,**/SKILL.md}", { cwd: root, absolute: true, include: "file", symlink: true, dot: true })
    .pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!matches) return sourceFailure("scan-failed", sourceLabel, `Skill root cannot be scanned: ${root}`, root)

  const loaded = yield* Effect.forEach(
    matches.toSorted(),
    (match) => loadFile(fs, registration, source, kind, sourceLabel, root, match, identity),
    { concurrency: 8 },
  )
  return {
    entries: loaded.flatMap((item) => item.entries),
    diagnostics: loaded.flatMap((item) => item.diagnostics),
  }
})

const loadFile = Effect.fnUntraced(function* (
  fs: FSUtil.Interface,
  registration: Registration,
  source: Skill.DirectorySource | Skill.UrlSource,
  kind: Exclude<Skill.SourceKind, "built-in">,
  sourceLabel: string,
  root: string,
  match: string,
  identity?: { readonly identityRoot: string; readonly identityPrefix: string },
) {
  const location = yield* fs.realPath(path.resolve(match)).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (!location || !FSUtil.contains(root, location)) {
    return sourceFailure("path-escape", sourceLabel, "Skill file resolves outside its configured root", match)
  }

  const content = yield* fs.readFileStringSafe(location).pipe(Effect.catch(() => Effect.succeed(undefined)))
  if (content === undefined) return sourceFailure("read-failed", sourceLabel, "Skill file cannot be read", location)

  const markdown = ConfigMarkdown.parseOption(content)
  if (!markdown) return sourceFailure("invalid-frontmatter", sourceLabel, "Skill frontmatter is invalid", location)

  const frontmatter = decodeFrontmatter(markdown.data).valueOrUndefined
  if (!frontmatter) return sourceFailure("invalid-frontmatter", sourceLabel, "Skill frontmatter is invalid", location)

  const isPackage = path.basename(location) === "SKILL.md"
  const name = frontmatter.name ?? (isPackage ? undefined : path.basename(location, ".md"))
  if (!name || name.length > 64 || !namePattern.test(name))
    return sourceFailure(
      "invalid-name",
      sourceLabel,
      "Skill name must match ^[a-z0-9]+(-[a-z0-9]+)*$ and be at most 64 characters",
      location,
    )

  if (isPackage && path.basename(path.dirname(location)) !== name)
    return sourceFailure(
      "name-mismatch",
      sourceLabel,
      `Skill name "${name}" does not match directory "${path.basename(path.dirname(location))}"`,
      location,
    )

  const relative = normalizeRelative(path.relative(root, location))
  const identityPath = identity ? normalizeRelative(path.posix.join(identity.identityPrefix, relative)) : relative
  const id = makeID(kind, identity?.identityRoot ?? root, identityPath)
  const label = labelForEntry(registration, source, kind, id)
  const metadata = Skill.Metadata.make({
    id,
    name,
    description: frontmatter.description,
    sourceLabel: label,
    digest: makeDigest(markdown.content),
  })
  return {
    entries: [
      {
        metadata,
        source: Skill.SourceDetail.make({
          kind,
          label,
          root: AbsolutePath.make(root),
          relativePath: RelativePath.make(relative),
        }),
        sourceKey: key(registration),
        location: AbsolutePath.make(location),
        content: markdown.content,
        slash: frontmatter.slash,
      },
    ],
    diagnostics: [],
  }
})

function sourceFailure(
  kind: Skill.DiagnosticKind,
  sourceLabel: string,
  message: string,
  location?: string,
): SourceResult {
  return {
    entries: [],
    diagnostics: [
      Skill.Diagnostic.make({
        kind,
        severity: kind === "path-escape" ? "error" : "warning",
        sourceLabel,
        message,
        ...(location === undefined ? {} : { path: AbsolutePath.make(path.resolve(location)) }),
      }),
    ],
  }
}

function sourceLabelFor(
  registration: Registration,
  source: Skill.DirectorySource | Skill.UrlSource,
  kind: Exclude<Skill.SourceKind, "built-in">,
) {
  if (registration.options?.label) return registration.options.label
  if (kind === "opencode-global") return "OpenCode config"
  if (kind === "opencode-project") return "Project .opencode"
  if (kind === "url" && source.type === "url")
    return normalizeUrl(source.url) ? `URL ${new URL(source.url).host}` : "URL source"
  if (source.type === "directory" && isSkillRoot(source.path, process.env.CODEX_HOME, ".codex")) return "Codex"
  if (source.type === "directory" && isSkillRoot(source.path, undefined, ".claude")) return "Claude"
  return "Imported"
}

function isSkillRoot(root: string, configuredHome: string | undefined, defaultHome: string) {
  const resolved = path.resolve(root)
  if (configuredHome?.trim() && resolved === path.resolve(configuredHome.trim(), "skills")) return true
  return path.basename(resolved) === "skills" && path.basename(path.dirname(resolved)) === defaultHome
}

function labelForEntry(
  registration: Registration,
  source: Skill.DirectorySource | Skill.UrlSource,
  kind: Exclude<Skill.SourceKind, "built-in">,
  id: Skill.ID,
) {
  return `${sourceLabelFor(registration, source, kind)} · ${id.slice(4, 12)}`
}

function normalizeUrl(value: string) {
  if (!URL.canParse(value)) return
  const url = new URL(value.endsWith("/") ? value : `${value}/`)
  if (!/^(https?:)$/.test(url.protocol)) return
  url.username = ""
  url.password = ""
  url.hash = ""
  return url.href
}

function normalizeRelative(value: string) {
  return value.split(path.sep).join("/")
}

function makeID(kind: Skill.SourceKind, root: string, relative: string) {
  return Skill.ID.make(`skl_${Hash.sha256(`${kind}\0${root}\0${relative}`)}`)
}

function makeDigest(content: string) {
  return Skill.Digest.make(Hash.sha256(content))
}

function compareDiagnostic(a: Skill.Diagnostic, b: Skill.Diagnostic) {
  return (
    a.kind.localeCompare(b.kind) ||
    a.sourceLabel.localeCompare(b.sourceLabel) ||
    (a.path ?? "").localeCompare(b.path ?? "") ||
    a.message.localeCompare(b.message)
  )
}

export function key(registration: Registration) {
  return `${Skill.Source.key(registration.source)}:${registration.options?.kind ?? ""}:${registration.options?.label ?? ""}:${registration.options?.identity ?? ""}`
}

export const node = makeGlobalNode({
  service: Service,
  layer,
  deps: [ControllerFileSystem.node, SkillDiscovery.node],
})
