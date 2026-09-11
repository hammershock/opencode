export * as TargetRegistry from "./target-registry"

import path from "path"
import fs from "fs/promises"
import { createHash, randomUUID } from "crypto"
import { applyEdits, type Node, type ParseError, modify, parse, parseTree, printParseErrorCode } from "jsonc-parser"
import { Context, Effect, Layer, Schema } from "effect"
import { Global } from "./global"
import { Location } from "./location"
import { Flock } from "./util/flock"
import { makeGlobalNode } from "./effect/app-node"
import { Database } from "./database/database"
import { SessionTable } from "./session/sql"

export type SshConfigConnection = {
  readonly type: "ssh-config"
  readonly host: string
}

export type ManualConnection = {
  readonly type: "manual"
  readonly host: string
  readonly user: string
  readonly port: number
  readonly identityFile?: string
}

export type Connection = SshConfigConnection | ManualConnection

export type Definition = {
  readonly id: Location.TargetID
  /** Runtime view only. A saved config never claims current connectivity without a fresh probe. */
  readonly status: "unverified"
  readonly health?: HealthResult
  readonly name: string
  readonly transport: "ssh"
  readonly connection: Connection
  readonly defaultDirectory?: string
  readonly workspaceRoots: readonly string[]
  readonly command?: { readonly program: string; readonly args: readonly string[] }
  readonly skillStagingRoot?: string
}

export type Input = Omit<Definition, "id" | "status" | "health">

export type Diagnostic = {
  readonly severity: "error" | "warning"
  readonly path: string
  readonly message: string
  readonly offset?: number
}

export type Snapshot = {
  readonly path: string
  readonly revision: string
  readonly targets: readonly Definition[]
  readonly diagnostics: readonly Diagnostic[]
  readonly valid: boolean
}

export type ConnectionStage = "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"

export type ProbeResult =
  | { readonly status: "ready"; readonly stages: readonly ConnectionStage[] }
  | { readonly status: "unavailable" | "invalid"; readonly stage: ConnectionStage; readonly message: string }

export type HealthResult = ProbeResult & { readonly checkedAt: number; readonly trustedUntil: number }
export const HEALTH_TRUST_MS = 30_000

export type ImportPreview = {
  readonly source: string
  readonly sourceRevision: string
  readonly candidates: readonly Definition[]
  readonly diagnostics: readonly Diagnostic[]
}

/** Implemented by the Rexd transport task. Registry and UI callers never execute SSH directly. */
export interface ConnectionProbe {
  readonly test: (target: Definition) => Promise<ProbeResult>
  readonly prepare: (target: Definition, directory?: string) => Promise<ProbeResult>
  readonly inspect?: (target: Input) => Promise<{ readonly home: string }>
  readonly complete?: (
    target: Input,
    input: { readonly value: string; readonly cursor: number; readonly cwd: string },
  ) => Promise<{ readonly value: string; readonly cursor: number; readonly candidates: readonly string[] }>
}

/** Supplied by RFC-0009 Session recovery. A non-empty caller array alone never authorizes ID reuse. */
export interface RestoreAuthorizer {
  readonly authorize: (targetID: Location.TargetID, referencedSessionIDs: readonly string[]) => Promise<boolean>
}

export class RevisionConflictError extends Schema.TaggedErrorClass<RevisionConflictError>()(
  "TargetRegistry.RevisionConflictError",
  { expected: Schema.String, actual: Schema.String },
) {}

export class InvalidConfigError extends Schema.TaggedErrorClass<InvalidConfigError>()(
  "TargetRegistry.InvalidConfigError",
  {
    diagnostics: Schema.Array(Schema.Struct({ severity: Schema.String, path: Schema.String, message: Schema.String })),
  },
) {}

export class NotFoundError extends Schema.TaggedErrorClass<NotFoundError>()("TargetRegistry.NotFoundError", {
  targetID: Location.TargetID,
}) {}

export class NameConflictError extends Schema.TaggedErrorClass<NameConflictError>()(
  "TargetRegistry.NameConflictError",
  {
    name: Schema.String,
  },
) {}

export class RestoreAuthorizationError extends Schema.TaggedErrorClass<RestoreAuthorizationError>()(
  "TargetRegistry.RestoreAuthorizationError",
  { targetID: Location.TargetID },
) {}

export interface Interface {
  readonly load: () => Promise<Snapshot>
  readonly create: (input: Input, expectedRevision: string) => Promise<{ target: Definition; snapshot: Snapshot }>
  readonly update: (
    targetID: Location.TargetID,
    input: Input,
    expectedRevision: string,
  ) => Promise<{ target: Definition; snapshot: Snapshot }>
  readonly remove: (targetID: Location.TargetID, expectedRevision: string) => Promise<Snapshot>
  readonly restoreMissing: (
    targetID: Location.TargetID,
    input: Input,
    referencedSessionIDs: readonly string[],
    expectedRevision: string,
  ) => Promise<{ target: Definition; snapshot: Snapshot }>
  readonly testConnection: (targetID: Location.TargetID) => Promise<HealthResult>
  readonly refreshConnection: (targetID: Location.TargetID) => Promise<HealthResult>
  readonly prepare: (targetID: Location.TargetID, directory?: string) => Promise<HealthResult>
  readonly validate: (input: Input) => Promise<void>
  readonly inspect: (input: Input) => Promise<{ readonly home: string }>
  readonly complete: (
    target: Input,
    input: { readonly value: string; readonly cursor: number; readonly cwd: string },
  ) => Promise<{ readonly value: string; readonly cursor: number; readonly candidates: readonly string[] }>
  /** Reads the legacy file only after an explicit UI/user action. It is never an active config source. */
  readonly previewLegacyImport: () => Promise<ImportPreview>
  readonly importLegacy: (
    sourceRevision: string,
    expectedRevision: string,
  ) => Promise<{ readonly imported: readonly Definition[]; readonly snapshot: Snapshot }>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/TargetRegistry") {}

export function make(options: {
  readonly directory: string
  readonly legacyFile?: string
  readonly probe?: ConnectionProbe
  readonly restoreAuthorizer?: RestoreAuthorizer
  readonly healthTrustMs?: number
}): Interface {
  const filepath = path.join(options.directory, "targets.jsonc")
  const legacyFile = options.legacyFile ?? path.join(path.dirname(options.directory), "rexd", "targets.json")
  const health = new Map<Location.TargetID, HealthResult>()
  const probes = new Map<string, Promise<HealthResult>>()

  const currentHealth = (targetID: Location.TargetID) => {
    const value = health.get(targetID)
    if (!value || value.trustedUntil <= Date.now()) {
      health.delete(targetID)
      return undefined
    }
    return value
  }
  const decorate = (snapshot: Snapshot): Snapshot => ({
    ...snapshot,
    targets: snapshot.targets.map((target) => ({ ...target, health: currentHealth(target.id) })),
  })
  const load = async () => decorate(await read(filepath))

  const mutate = async <A>(expectedRevision: string, change: (text: string, snapshot: Snapshot) => [string, A]) =>
    Flock.withLock(`target-registry:${filepath}`, async () => {
      const snapshot = await read(filepath)
      if (snapshot.revision !== expectedRevision)
        throw new RevisionConflictError({ expected: expectedRevision, actual: snapshot.revision })
      if (!snapshot.valid)
        throw new InvalidConfigError({
          diagnostics: snapshot.diagnostics.map((item) => ({
            severity: item.severity,
            path: item.path,
            message: item.message,
          })),
        })
      const [text, value] = change(await readText(filepath), snapshot)
      await atomicWrite(filepath, text)
      return { value, snapshot: await read(filepath) }
    })

  const find = async (targetID: Location.TargetID) => {
    const snapshot = await load()
    const target = snapshot.targets.find((item) => item.id === targetID)
    if (!target) throw new NotFoundError({ targetID })
    return target
  }

  const record = (targetID: Location.TargetID, result: ProbeResult) => {
    const checkedAt = Date.now()
    const value = { ...result, checkedAt, trustedUntil: checkedAt + (options.healthTrustMs ?? HEALTH_TRUST_MS) }
    health.set(targetID, value)
    return value
  }
  const probe = async (target: Definition, mode: "test" | "prepare", directory?: string) => {
    const key = `${mode}:${target.id}:${directory ?? ""}`
    const active = probes.get(key)
    if (active) return active
    const operation = Promise.resolve()
      .then(() =>
        !options.probe
          ? ({
              status: "unavailable",
              stage: mode === "prepare" ? "prepare" : "ssh",
              message: "Rexd transport is not registered",
            } as const)
          : mode === "test"
            ? options.probe.test(target)
            : options.probe.prepare(target, directory),
      )
      .then((result) => record(target.id, result))
      .finally(() => probes.delete(key))
    probes.set(key, operation)
    return operation
  }

  return {
    load,
    async create(input, expectedRevision) {
      const id = Location.TargetID.make(randomUUID())
      const result = await mutate(expectedRevision, (text, snapshot) => {
        validateInput(input, snapshot.targets)
        const target = { id, status: "unverified" as const, ...input } satisfies Definition
        return [edit(text, ["targets", id], encode(target)), target]
      })
      return { target: result.value, snapshot: result.snapshot }
    },
    async update(targetID, input, expectedRevision) {
      const result = await mutate(expectedRevision, (text, snapshot) => {
        if (!snapshot.targets.some((target) => target.id === targetID)) throw new NotFoundError({ targetID })
        validateInput(input, snapshot.targets, targetID)
        const target = { id: targetID, status: "unverified" as const, ...input } satisfies Definition
        const fields = encode(target)
        const scalar = [
          "name",
          "transport",
          "defaultDirectory",
          "workspaceRoots",
          "command",
          "skillStagingRoot",
        ] as const
        const base = scalar.reduce((current, key) => edit(current, ["targets", targetID, key], fields[key]), text)
        const connectionKeys = ["type", "host", "user", "port", "identityFile"] as const
        const connection =
          fields.connection.type === "manual"
            ? fields.connection
            : { ...fields.connection, user: undefined, port: undefined, identityFile: undefined }
        const updated = connectionKeys.reduce(
          (current, key) => edit(current, ["targets", targetID, "connection", key], connection[key]),
          base,
        )
        return [updated, target]
      })
      health.delete(targetID)
      return { target: result.value, snapshot: result.snapshot }
    },
    async remove(targetID, expectedRevision) {
      const result = await mutate(expectedRevision, (text, snapshot) => {
        if (!snapshot.targets.some((target) => target.id === targetID)) throw new NotFoundError({ targetID })
        return [edit(text, ["targets", targetID], undefined), undefined]
      })
      health.delete(targetID)
      return result.snapshot
    },
    async restoreMissing(targetID, input, referencedSessionIDs, expectedRevision) {
      if (
        !referencedSessionIDs.length ||
        !options.restoreAuthorizer ||
        !(await options.restoreAuthorizer.authorize(targetID, referencedSessionIDs))
      )
        throw new RestoreAuthorizationError({ targetID })
      const result = await mutate(expectedRevision, (text, snapshot) => {
        if (snapshot.targets.some((target) => target.id === targetID)) throw new NameConflictError({ name: input.name })
        validateInput(input, snapshot.targets)
        const target = { id: targetID, status: "unverified" as const, ...input } satisfies Definition
        return [edit(text, ["targets", targetID], encode(target)), target]
      })
      return { target: result.value, snapshot: result.snapshot }
    },
    async testConnection(targetID) {
      const target = await find(targetID)
      return currentHealth(targetID) ?? probe(target, "test")
    },
    async refreshConnection(targetID) {
      const target = await find(targetID)
      return probe(target, "test")
    },
    async prepare(targetID, directory) {
      const target = await find(targetID)
      return probe(target, "prepare", directory)
    },
    async validate(input) {
      validateInput(input, (await load()).targets)
    },
    async inspect(input) {
      if (!options.probe?.inspect) throw new Error("Rexd transport is not registered")
      return options.probe.inspect(input)
    },
    async complete(target, input) {
      if (!options.probe?.complete) throw new Error("Rexd transport is not registered")
      return options.probe.complete(target, input)
    },
    async previewLegacyImport() {
      const text = await fs.readFile(legacyFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      return decodeLegacy(legacyFile, text)
    },
    async importLegacy(sourceRevision, expectedRevision) {
      const current = await fs.readFile(legacyFile, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return ""
        throw error
      })
      if (hash(current) !== sourceRevision)
        throw new RevisionConflictError({ expected: sourceRevision, actual: hash(current) })
      const preview = decodeLegacy(legacyFile, current)
      const result = await mutate(expectedRevision, (text, snapshot) => {
        preview.candidates.forEach((target) =>
          validateInput(target, [...snapshot.targets, ...preview.candidates], target.id),
        )
        const updated = preview.candidates.reduce(
          (value, target) => edit(value, ["targets", target.id], encode(target)),
          text,
        )
        return [updated, preview.candidates]
      })
      return { imported: result.value, snapshot: result.snapshot }
    },
  }
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const { db } = yield* Database.Service
    return Service.of(
      make({
        directory: global.config,
        legacyFile: path.join(global.home, ".config", "rexd", "targets.json"),
        restoreAuthorizer: {
          authorize: async (targetID, referencedSessionIDs) => {
            const rows = await Effect.runPromise(
              db.select({ id: SessionTable.id, target: SessionTable.target }).from(SessionTable),
            )
            const actual = rows
              .filter((row) => row.target?.type === "rexd" && row.target.targetID === targetID)
              .map((row) => row.id)
              .sort()
            const expected = [...new Set(referencedSessionIDs)].sort()
            return (
              actual.length > 0 &&
              actual.length === expected.length &&
              actual.every((id, index) => id === expected[index])
            )
          },
        },
      }),
    )
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node, Database.node] })

async function read(filepath: string): Promise<Snapshot> {
  const text = await readText(filepath)
  const revision = hash(text)
  if (!text.trim()) return { path: filepath, revision, targets: [], diagnostics: [], valid: true }

  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  const diagnostics: Diagnostic[] = errors.map((error) => ({
    severity: "error",
    path: "$",
    message: printParseErrorCode(error.error),
    offset: error.offset,
  }))
  const tree = parseTree(text, [], { allowTrailingComma: true })
  if (tree) diagnostics.push(...structureDiagnostics(tree))
  const targets = decode(value, diagnostics)
  return {
    path: filepath,
    revision,
    targets,
    diagnostics,
    valid: !diagnostics.some((item) => item.severity === "error"),
  }
}

async function readText(filepath: string) {
  return fs.readFile(filepath, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return '{\n  "version": 1,\n  "targets": {}\n}\n'
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
    await fs.rm(temporary, { force: true }).catch(() => undefined)
  }
}

function edit(text: string, jsonPath: readonly (string | number)[], value: unknown) {
  return applyEdits(text, modify(text, [...jsonPath], value, { formattingOptions: { tabSize: 2, insertSpaces: true } }))
}

function encode(target: Definition) {
  return {
    name: target.name,
    transport: target.transport,
    connection: target.connection,
    defaultDirectory: target.defaultDirectory,
    workspaceRoots: target.workspaceRoots,
    command: target.command,
    skillStagingRoot: target.skillStagingRoot,
  }
}

function validateInput(input: Input, existing: readonly Definition[], ownID?: Location.TargetID) {
  const diagnostics: Diagnostic[] = []
  decodeTarget("$input", input, diagnostics, Location.TargetID.make(ownID ?? randomUUID()))
  if (existing.some((target) => target.id !== ownID && target.name === input.name))
    throw new NameConflictError({ name: input.name })
  if (diagnostics.some((item) => item.severity === "error")) throw new InvalidConfigError({ diagnostics })
}

function decode(value: unknown, diagnostics: Diagnostic[]) {
  if (!record(value)) {
    diagnostics.push(error("$", "Expected an object"))
    return []
  }
  if (value.version !== 1) diagnostics.push(error("$.version", "Expected version 1"))
  if (!record(value.targets)) {
    diagnostics.push(error("$.targets", "Expected an object"))
    return []
  }
  const targets = Object.entries(value.targets).flatMap(([id, target]) => {
    if (!Schema.is(Location.TargetID)(id)) {
      diagnostics.push(error(`$.targets.${id}`, "Target key must be a UUID"))
      return []
    }
    const decoded = decodeTarget(`$.targets.${id}`, target, diagnostics, Location.TargetID.make(id))
    return decoded ? [decoded] : []
  })
  const names = new Set<string>()
  targets.forEach((target) => {
    if (names.has(target.name)) diagnostics.push(error(`$.targets.${target.id}.name`, "Target name must be unique"))
    names.add(target.name)
  })
  return targets
}

function decodeTarget(prefix: string, value: unknown, diagnostics: Diagnostic[], id: Location.TargetID) {
  if (!record(value)) {
    diagnostics.push(error(prefix, "Expected an object"))
    return
  }
  const name = string(value.name, `${prefix}.name`, diagnostics)
  if (value.transport !== "ssh") diagnostics.push(error(`${prefix}.transport`, "Only ssh transport is supported"))
  const connection = decodeConnection(value.connection, `${prefix}.connection`, diagnostics)
  const roots = stringArray(value.workspaceRoots, `${prefix}.workspaceRoots`, diagnostics)
  const defaultDirectory =
    value.defaultDirectory === undefined
      ? undefined
      : string(value.defaultDirectory, `${prefix}.defaultDirectory`, diagnostics)
  const command = decodeCommand(value.command, `${prefix}.command`, diagnostics)
  const skillStagingRoot =
    value.skillStagingRoot === undefined
      ? undefined
      : string(value.skillStagingRoot, `${prefix}.skillStagingRoot`, diagnostics)
  roots?.forEach((root, index) => {
    if (!path.posix.isAbsolute(root))
      diagnostics.push(error(`${prefix}.workspaceRoots[${index}]`, "Expected an absolute remote path"))
  })
  if (defaultDirectory && !path.posix.isAbsolute(defaultDirectory))
    diagnostics.push(error(`${prefix}.defaultDirectory`, "Expected an absolute remote path"))
  if (defaultDirectory && roots && !roots.some((root) => within(root, defaultDirectory)))
    diagnostics.push(error(`${prefix}.defaultDirectory`, "Directory must be inside a workspace root"))
  if (skillStagingRoot && !path.posix.isAbsolute(skillStagingRoot))
    diagnostics.push(error(`${prefix}.skillStagingRoot`, "Expected an absolute remote path"))
  if (skillStagingRoot && path.posix.normalize(skillStagingRoot) === "/")
    diagnostics.push(error(`${prefix}.skillStagingRoot`, "Skill staging root cannot be the remote filesystem root"))
  if (skillStagingRoot && !command)
    diagnostics.push(error(`${prefix}.skillStagingRoot`, "Field is only valid for a custom Rexd command"))
  if (
    !name ||
    !connection ||
    !roots?.length ||
    diagnostics.some((item) => item.severity === "error" && item.path.startsWith(prefix))
  )
    return
  return {
    id,
    status: "unverified" as const,
    name,
    transport: "ssh" as const,
    connection,
    defaultDirectory,
    workspaceRoots: roots,
    command,
    skillStagingRoot,
  }
}

function decodeConnection(value: unknown, prefix: string, diagnostics: Diagnostic[]): Connection | undefined {
  if (!record(value)) {
    diagnostics.push(error(prefix, "Expected an object"))
    return
  }
  if (value.type === "ssh-config") {
    ;["user", "port", "identityFile"].forEach((key) => {
      if (value[key] !== undefined) diagnostics.push(error(`${prefix}.${key}`, `Field is not valid for ssh-config`))
    })
    const host = string(value.host, `${prefix}.host`, diagnostics)
    return host ? { type: "ssh-config", host } : undefined
  }
  if (value.type === "manual") {
    const host = string(value.host, `${prefix}.host`, diagnostics)
    const user = string(value.user, `${prefix}.user`, diagnostics)
    const port = value.port
    if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65535)
      diagnostics.push(error(`${prefix}.port`, "Expected an integer from 1 to 65535"))
    const identityFile =
      value.identityFile === undefined ? undefined : string(value.identityFile, `${prefix}.identityFile`, diagnostics)
    return host && user && Number.isInteger(port) && Number(port) >= 1 && Number(port) <= 65535
      ? { type: "manual", host, user, port: Number(port), identityFile }
      : undefined
  }
  diagnostics.push(error(`${prefix}.type`, "Expected ssh-config or manual"))
}

function decodeCommand(value: unknown, prefix: string, diagnostics: Diagnostic[]) {
  if (value === undefined) return
  if (!record(value)) {
    diagnostics.push(error(prefix, "Expected a command object"))
    return
  }
  const program = string(value.program, `${prefix}.program`, diagnostics)
  const args = value.args === undefined ? [] : stringArrayAllowEmpty(value.args, `${prefix}.args`, diagnostics)
  return program && args ? { program, args } : undefined
}

function string(value: unknown, location: string, diagnostics: Diagnostic[]) {
  if (typeof value === "string" && value.trim()) return value
  diagnostics.push(error(location, "Expected a non-empty string"))
}

function stringArray(value: unknown, location: string, diagnostics: Diagnostic[]) {
  if (!Array.isArray(value)) {
    diagnostics.push(error(location, "Expected a non-empty string array"))
    return
  }
  const result = value.flatMap((item, index) => {
    const decoded = string(item, `${location}[${index}]`, diagnostics)
    return decoded ? [decoded] : []
  })
  if (!result.length) diagnostics.push(error(location, "Expected at least one workspace root"))
  return result
}

function stringArrayAllowEmpty(value: unknown, location: string, diagnostics: Diagnostic[]) {
  if (!Array.isArray(value)) {
    diagnostics.push(error(location, "Expected a string array"))
    return
  }
  return value.flatMap((item, index) => {
    const decoded = string(item, `${location}[${index}]`, diagnostics)
    return decoded ? [decoded] : []
  })
}

function within(root: string, directory: string) {
  const relative = path.posix.relative(path.posix.normalize(root), path.posix.normalize(directory))
  return relative === "" || (!relative.startsWith("..") && !path.posix.isAbsolute(relative))
}

function structureDiagnostics(root: Node) {
  const diagnostics: Diagnostic[] = []
  const visit = (node: Node, prefix: string) => {
    if (node.type !== "object") {
      node.children?.forEach((child) => visit(child, prefix))
      return
    }
    const seen = new Set<string>()
    node.children?.forEach((property) => {
      const key = String(property.children?.[0]?.value ?? "")
      const childPath = `${prefix}.${key}`
      if (seen.has(key)) diagnostics.push({ ...error(childPath, "Duplicate property"), offset: property.offset })
      seen.add(key)
      const allowed = allowedKeys(prefix)
      if (allowed && !allowed.has(key))
        diagnostics.push({
          severity: "warning",
          path: childPath,
          message: "Unknown field is preserved",
          offset: property.offset,
        })
      const value = property.children?.[1]
      if (value) visit(value, childPath)
    })
  }
  visit(root, "$.")
  return diagnostics.map((item) => ({ ...item, path: item.path.replace("$..", "$.") }))
}

function allowedKeys(prefix: string) {
  if (prefix === "$.") return new Set(["version", "targets"])
  if (/^\$\.targets\.[^.]+$/.test(prefix))
    return new Set([
      "name",
      "transport",
      "connection",
      "defaultDirectory",
      "workspaceRoots",
      "command",
      "skillStagingRoot",
    ])
  if (/^\$\.targets\.[^.]+\.connection$/.test(prefix)) return new Set(["type", "host", "user", "port", "identityFile"])
  if (/^\$\.targets\.[^.]+\.command$/.test(prefix)) return new Set(["program", "args"])
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function error(location: string, message: string): Diagnostic {
  return { severity: "error", path: location, message }
}

function hash(text: string) {
  return createHash("sha256").update(text).digest("hex")
}

function decodeLegacy(source: string, text: string): ImportPreview {
  const diagnostics: Diagnostic[] = []
  if (!text.trim()) return { source, sourceRevision: hash(text), candidates: [], diagnostics }
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  errors.forEach((item) =>
    diagnostics.push({ severity: "error", path: "$", message: printParseErrorCode(item.error), offset: item.offset }),
  )
  if (!record(value) || !record(value.targets)) {
    diagnostics.push(error("$.targets", "Expected a legacy targets object"))
    return { source, sourceRevision: hash(text), candidates: [], diagnostics }
  }
  const candidates = Object.entries(value.targets).flatMap(([name, item]) => {
    const prefix = `$.targets.${name}`
    if (!record(item)) {
      diagnostics.push(error(prefix, "Expected an object"))
      return []
    }
    const host = string(item.host, `${prefix}.host`, diagnostics)
    if (!host) return []
    const roots = Array.isArray(item.workspaceRoots)
      ? stringArray(item.workspaceRoots, `${prefix}.workspaceRoots`, diagnostics)
      : ["/"]
    const connection: Connection =
      item.user === undefined && item.port === undefined && item.identityFile === undefined
        ? { type: "ssh-config", host }
        : {
            type: "manual",
            host,
            user: typeof item.user === "string" && item.user ? item.user : "",
            port: typeof item.port === "number" ? item.port : 22,
            identityFile: typeof item.identityFile === "string" ? item.identityFile : undefined,
          }
    if (connection.type === "manual" && !connection.user)
      diagnostics.push(error(`${prefix}.user`, "Manual legacy target requires a user before import"))
    if (item.command !== undefined)
      diagnostics.push({
        severity: "warning",
        path: `${prefix}.command`,
        message: "Legacy shell command was not imported; review and enter structured program/args explicitly",
      })
    ;[
      "description",
      "home",
      "platform",
      "wslDistribution",
      "wslUser",
      "rootPolicy",
      "capabilities",
      "sshOptions",
    ].forEach((key) => {
      if (item[key] !== undefined)
        diagnostics.push({
          severity: "warning",
          path: `${prefix}.${key}`,
          message: "Legacy field cannot be represented in target registry v1 and was not imported",
        })
    })
    if (!roots?.length || (connection.type === "manual" && !connection.user)) return []
    return [
      {
        id: Location.TargetID.make(randomUUID()),
        status: "unverified" as const,
        name,
        transport: "ssh" as const,
        connection,
        defaultDirectory: typeof item.defaultCwd === "string" ? item.defaultCwd : undefined,
        workspaceRoots: roots,
      },
    ]
  })
  return { source, sourceRevision: hash(text), candidates, diagnostics }
}
