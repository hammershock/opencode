export * as Target from "./target"

import { Schema } from "effect"
import { Location } from "./location"

export const SshConfigConnection = Schema.Struct({
  type: Schema.Literal("ssh-config"),
  host: Schema.String,
})

export const ManualConnection = Schema.Struct({
  type: Schema.Literal("manual"),
  host: Schema.String,
  user: Schema.String,
  port: Schema.Number,
  identityFile: Schema.optional(Schema.String),
})

export const Connection = Schema.Union([SshConfigConnection, ManualConnection])

export const Command = Schema.Struct({
  program: Schema.String,
  args: Schema.Array(Schema.String),
})

export const Input = Schema.Struct({
  name: Schema.String,
  transport: Schema.Literal("ssh"),
  connection: Connection,
  defaultDirectory: Schema.optional(Schema.String),
  workspaceRoots: Schema.Array(Schema.String),
  command: Schema.optional(Command),
})

export const Definition = Schema.Struct({
  id: Location.TargetID,
  status: Schema.Literal("unverified"),
  ...Input.fields,
})

export const Diagnostic = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  path: Schema.String,
  message: Schema.String,
  offset: Schema.optional(Schema.Number),
})

export const Snapshot = Schema.Struct({
  path: Schema.String,
  revision: Schema.String,
  targets: Schema.Array(Definition),
  diagnostics: Schema.Array(Diagnostic),
  valid: Schema.Boolean,
})

export const ConnectionStage = Schema.Literals([
  "ssh",
  "environment",
  "prepare",
  "handshake",
  "capabilities",
  "directory",
])

export const ProbeResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), stages: Schema.Array(ConnectionStage) }),
  Schema.Struct({
    status: Schema.Literals(["unavailable", "invalid"]),
    stage: ConnectionStage,
    message: Schema.String,
  }),
])

export const WizardInspection = Schema.Struct({ home: Schema.String })
export const PathCompletion = Schema.Struct({
  value: Schema.String,
  cursor: Schema.Number,
  candidates: Schema.Array(Schema.String),
})

export const ImportPreview = Schema.Struct({
  source: Schema.String,
  sourceRevision: Schema.String,
  candidates: Schema.Array(Definition),
  diagnostics: Schema.Array(Diagnostic),
})

export const MutationResult = Schema.Struct({ target: Definition, snapshot: Snapshot })
export const ImportResult = Schema.Struct({ imported: Schema.Array(Definition), snapshot: Snapshot })
