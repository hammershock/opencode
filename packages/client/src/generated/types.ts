import type { OpenCodeEventEncoded } from "@opencode-ai/protocol/groups/event"

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue }

export type UnauthorizedError = { readonly _tag: "UnauthorizedError"; readonly message: string }
export const isUnauthorizedError = (value: unknown): value is UnauthorizedError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnauthorizedError"

export type InvalidRequestError = {
  readonly _tag: "InvalidRequestError"
  readonly message: string
  readonly kind?: string | undefined
  readonly field?: string | undefined
}
export const isInvalidRequestError = (value: unknown): value is InvalidRequestError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidRequestError"

export type InvalidCursorError = { readonly _tag: "InvalidCursorError"; readonly message: string }
export const isInvalidCursorError = (value: unknown): value is InvalidCursorError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "InvalidCursorError"

export type SessionNotFoundError = {
  readonly _tag: "SessionNotFoundError"
  readonly sessionID: string
  readonly message: string
}
export const isSessionNotFoundError = (value: unknown): value is SessionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SessionNotFoundError"

export type ServiceUnavailableError = {
  readonly _tag: "ServiceUnavailableError"
  readonly message: string
  readonly service?: string | undefined
}
export const isServiceUnavailableError = (value: unknown): value is ServiceUnavailableError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ServiceUnavailableError"

export type ConflictError = {
  readonly _tag: "ConflictError"
  readonly message: string
  readonly resource?: string | undefined
}
export const isConflictError = (value: unknown): value is ConflictError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ConflictError"

export type SkillMentionError = {
  readonly _tag: "SkillMentionError"
  readonly message: string
  readonly kind:
    | "invalid-mention"
    | "unavailable"
    | "target-inapplicable"
    | "permission-denied"
    | "stale-catalog"
    | "malformed"
  readonly skillID: string
  readonly name: string
}
export const isSkillMentionError = (value: unknown): value is SkillMentionError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "SkillMentionError"

export type MessageNotFoundError = {
  readonly _tag: "MessageNotFoundError"
  readonly sessionID: string
  readonly messageID: string
  readonly message: string
}
export const isMessageNotFoundError = (value: unknown): value is MessageNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "MessageNotFoundError"

export type UnknownError = {
  readonly _tag: "UnknownError"
  readonly message: string
  readonly ref?: string | undefined
}
export const isUnknownError = (value: unknown): value is UnknownError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "UnknownError"

export type ProviderNotFoundError = {
  readonly _tag: "ProviderNotFoundError"
  readonly providerID: string
  readonly message: string
}
export const isProviderNotFoundError = (value: unknown): value is ProviderNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ProviderNotFoundError"

export type PermissionNotFoundError = {
  readonly _tag: "PermissionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isPermissionNotFoundError = (value: unknown): value is PermissionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PermissionNotFoundError"

export type PtyNotFoundError = { readonly _tag: "PtyNotFoundError"; readonly ptyID: string; readonly message: string }
export const isPtyNotFoundError = (value: unknown): value is PtyNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "PtyNotFoundError"

export type QuestionNotFoundError = {
  readonly _tag: "QuestionNotFoundError"
  readonly requestID: string
  readonly message: string
}
export const isQuestionNotFoundError = (value: unknown): value is QuestionNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "QuestionNotFoundError"

export type ProjectCopyError = {
  readonly name: "ProjectCopyError"
  readonly data: { readonly message: string; readonly forceRequired?: boolean | undefined }
}
export const isProjectCopyError = (value: unknown): value is ProjectCopyError =>
  typeof value === "object" && value !== null && "name" in value && value["name"] === "ProjectCopyError"

export type ForbiddenError = { readonly _tag: "ForbiddenError"; readonly message: string }
export const isForbiddenError = (value: unknown): value is ForbiddenError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "ForbiddenError"

export type TargetNotFoundError = {
  readonly _tag: "TargetNotFoundError"
  readonly targetID: string
  readonly message: string
}
export const isTargetNotFoundError = (value: unknown): value is TargetNotFoundError =>
  typeof value === "object" && value !== null && "_tag" in value && value["_tag"] === "TargetNotFoundError"

export type HealthGetOutput = { readonly healthy: true }

export type LocationGetInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type LocationGetOutput = {
  readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
  readonly directory: string
  readonly workspaceID?: string
  readonly lastKnownTargetName?: string
  readonly project: { readonly id: string; readonly directory: string }
}

export type AgentsListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type AgentsListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
    readonly system?: string
    readonly description?: string
    readonly mode: "subagent" | "primary" | "all"
    readonly hidden: boolean
    readonly color?: string | "primary" | "secondary" | "accent" | "success" | "warning" | "error" | "info"
    readonly steps?: number
    readonly permissions: ReadonlyArray<{
      readonly action: string
      readonly resource: string
      readonly effect: "allow" | "deny" | "ask"
    }>
  }>
}

export type SessionsListInput = {
  readonly workspace?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["workspace"]
  readonly limit?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly search?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["search"]
  readonly directory?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["directory"]
  readonly project?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["project"]
  readonly subpath?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["subpath"]
  readonly cursor?: {
    readonly workspace?: string | undefined
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly search?: string | undefined
    readonly directory?: string | undefined
    readonly project?: string | undefined
    readonly subpath?: string | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type SessionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly approvalMode?: "normal" | "auto"
    readonly location: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    }
    readonly locationRevision?: number
    readonly portableTargetLabel?: string
    readonly syncSpaceID?: string
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }>
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type SessionsCreateInput = {
  readonly id?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    } | null
    readonly approvalMode?: ("normal" | "auto") | null
  }["id"]
  readonly agent?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    } | null
    readonly approvalMode?: ("normal" | "auto") | null
  }["agent"]
  readonly model?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    } | null
    readonly approvalMode?: ("normal" | "auto") | null
  }["model"]
  readonly location?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    } | null
    readonly approvalMode?: ("normal" | "auto") | null
  }["location"]
  readonly approvalMode?: {
    readonly id?: string | null
    readonly agent?: string | null
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string } | null
    readonly location?: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    } | null
    readonly approvalMode?: ("normal" | "auto") | null
  }["approvalMode"]
}

export type SessionsCreateOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly approvalMode?: "normal" | "auto"
    readonly location: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    }
    readonly locationRevision?: number
    readonly portableTargetLabel?: string
    readonly syncSpaceID?: string
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsActiveOutput = { readonly data: { readonly [x: string]: { readonly type: "running" } } }["data"]

export type SessionsGetInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly parentID?: string
    readonly projectID: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly cost: number
    readonly tokens: {
      readonly input: number
      readonly output: number
      readonly reasoning: number
      readonly cache: { readonly read: number; readonly write: number }
    }
    readonly time: { readonly created: number; readonly updated: number; readonly archived?: number }
    readonly title: string
    readonly approvalMode?: "normal" | "auto"
    readonly location: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    }
    readonly locationRevision?: number
    readonly portableTargetLabel?: string
    readonly syncSpaceID?: string
    readonly subpath?: string
    readonly revert?: {
      readonly messageID: string
      readonly partID?: string
      readonly snapshot?: string
      readonly diff?: string
      readonly files?: ReadonlyArray<{
        readonly path: string
        readonly status: "added" | "modified" | "deleted"
        readonly additions: number
        readonly deletions: number
        readonly patch: string
      }>
    }
  }
}["data"]

export type SessionsActivateInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsActivateOutput = {
  readonly data: {
    readonly status: "initialized" | "unchanged" | "advanced" | "retained" | "unavailable"
    readonly diagnostics: ReadonlyArray<{
      readonly kind:
        | "root-unavailable"
        | "scan-failed"
        | "path-escape"
        | "read-failed"
        | "invalid-frontmatter"
        | "invalid-name"
        | "invalid-description"
        | "legacy-layout"
        | "name-mismatch"
        | "duplicate-name"
        | "invalid-settings"
        | "missing-target"
        | "project-target-scope-ignored"
        | "reload-failed"
      readonly severity: "error" | "warning"
      readonly sourceLabel: string
    }>
  }
}["data"]

export type SessionsSwitchAgentInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly agent: { readonly agent: string }["agent"]
}

export type SessionsSwitchAgentOutput = void

export type SessionsSwitchModelInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly model: {
    readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
  }["model"]
}

export type SessionsSwitchModelOutput = void

export type SessionsPromptInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly skills?: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly source: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["id"]
  readonly prompt: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly skills?: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly source: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["prompt"]
  readonly delivery?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly skills?: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly source: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["delivery"]
  readonly resume?: {
    readonly id?: string | null
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly skills?: ReadonlyArray<{
        readonly id: string
        readonly name: string
        readonly source: { readonly start: number; readonly end: number; readonly text: string }
      }>
    }
    readonly delivery?: "steer" | "queue" | null
    readonly resume?: boolean | null
  }["resume"]
}

export type SessionsPromptOutput = {
  readonly data: {
    readonly admittedSeq: number
    readonly id: string
    readonly sessionID: string
    readonly prompt: {
      readonly text: string
      readonly files?: ReadonlyArray<{
        readonly uri: string
        readonly mime: string
        readonly name?: string
        readonly description?: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly agents?: ReadonlyArray<{
        readonly name: string
        readonly source?: { readonly start: number; readonly end: number; readonly text: string }
      }>
      readonly invocations?: ReadonlyArray<{
        readonly source: { readonly start: number; readonly end: number; readonly text: string }
        readonly snapshot: {
          readonly id: string
          readonly name: string
          readonly description?: string
          readonly digest: string
          readonly source: {
            readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
            readonly label: string
          }
          readonly content: string
          readonly status: "loaded"
        }
      }>
    }
    readonly delivery: "steer" | "queue"
    readonly timeCreated: number
    readonly promotedSeq?: number
  }
}["data"]

export type SessionsCompactInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCompactOutput = void

export type SessionsWaitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsWaitOutput = void

export type SessionsStageInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly messageID: { readonly messageID: string; readonly files?: boolean | undefined }["messageID"]
  readonly files?: { readonly messageID: string; readonly files?: boolean | undefined }["files"]
}

export type SessionsStageOutput = {
  readonly data: {
    readonly messageID: string
    readonly partID?: string
    readonly snapshot?: string
    readonly diff?: string
    readonly files?: ReadonlyArray<{
      readonly path: string
      readonly status: "added" | "modified" | "deleted"
      readonly additions: number
      readonly deletions: number
      readonly patch: string
    }>
  }
}["data"]

export type SessionsClearInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsClearOutput = void

export type SessionsCommitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsCommitOutput = void

export type SessionsContextInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsContextOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly skills?: ReadonlyArray<{
          readonly source: { readonly start: number; readonly end: number; readonly text: string }
          readonly snapshot: {
            readonly id: string
            readonly name: string
            readonly description?: string
            readonly digest: string
            readonly source: {
              readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
              readonly label: string
            }
            readonly content: string
            readonly status: "loaded"
          }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly skills?: ReadonlyArray<{
          readonly id: string
          readonly name: string
          readonly description?: string
          readonly digest: string
          readonly source: {
            readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
            readonly label: string
          }
          readonly content: string
          readonly status: "loaded"
        }>
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
}["data"]

export type SessionsModelContextInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsModelContextOutput = {
  readonly data: {
    readonly version: 1
    readonly generation: number
    readonly reason: "created" | "legacy-backfill" | "location-rebound" | "init"
    readonly locationRevision: number
    readonly environment: {
      readonly harness: "OpenCode Transit"
      readonly entrypoint: "opencode-transit"
      readonly targetKind: "local" | "rexd"
      readonly targetName: string
      readonly directory: string
      readonly projectRoot: string
      readonly vcs?: string
      readonly platform: string
    }
    readonly instructions: ReadonlyArray<{
      readonly id: string
      readonly origin: "global-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
      readonly scope: "global" | "project" | "nested"
      readonly source: string
      readonly declaredBy?: string
      readonly status: "loaded" | "ignored"
      readonly failureStage?: "discovery" | "read" | "fetch"
      readonly content?: string
      readonly digest?: string
    }>
    readonly digest: string
    readonly baseline: string
    readonly sources: {
      readonly [x: string]: {
        readonly value: JsonValue
        readonly baseline?: string
        readonly removed?: string
        readonly refresh?: "generation" | "activation"
      }
    }
  } | null
}["data"]

export type SessionsHistoryInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: { readonly limit?: number | undefined; readonly after?: number | undefined }["limit"]
  readonly after?: { readonly limit?: number | undefined; readonly after?: number | undefined }["after"]
}

export type SessionsHistoryOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.agent.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly agent: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.model.switched"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.moved"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly location: {
            readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
            readonly directory: string
            readonly workspaceID?: string
            readonly lastKnownTargetName?: string
          }
          readonly subdirectory?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.location.rebound"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly previous: {
            readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
            readonly directory: string
            readonly workspaceID?: string
            readonly lastKnownTargetName?: string
          }
          readonly location: {
            readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
            readonly directory: string
            readonly workspaceID?: string
            readonly lastKnownTargetName?: string
          }
          readonly revision: number
          readonly context?: {
            readonly version: 1
            readonly generation: number
            readonly reason: "created" | "legacy-backfill" | "location-rebound" | "init"
            readonly locationRevision: number
            readonly environment: {
              readonly harness: "OpenCode Transit"
              readonly entrypoint: "opencode-transit"
              readonly targetKind: "local" | "rexd"
              readonly targetName: string
              readonly directory: string
              readonly projectRoot: string
              readonly vcs?: string
              readonly platform: string
            }
            readonly instructions: ReadonlyArray<{
              readonly id: string
              readonly origin: "global-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
              readonly scope: "global" | "project" | "nested"
              readonly source: string
              readonly declaredBy?: string
              readonly status: "loaded" | "ignored"
              readonly failureStage?: "discovery" | "read" | "fetch"
              readonly content?: string
              readonly digest?: string
            }>
            readonly digest: string
            readonly baseline: string
            readonly sources: {
              readonly [x: string]: {
                readonly value: JsonValue
                readonly baseline?: string
                readonly removed?: string
                readonly refresh?: "generation" | "activation"
              }
            }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly invocations?: ReadonlyArray<{
              readonly source: { readonly start: number; readonly end: number; readonly text: string }
              readonly snapshot: {
                readonly id: string
                readonly name: string
                readonly description?: string
                readonly digest: string
                readonly source: {
                  readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
                  readonly label: string
                }
                readonly content: string
                readonly status: "loaded"
              }
            }>
          }
          readonly delivery: "steer" | "queue"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.prompt.admitted"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly prompt: {
            readonly text: string
            readonly files?: ReadonlyArray<{
              readonly uri: string
              readonly mime: string
              readonly name?: string
              readonly description?: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly agents?: ReadonlyArray<{
              readonly name: string
              readonly source?: { readonly start: number; readonly end: number; readonly text: string }
            }>
            readonly invocations?: ReadonlyArray<{
              readonly source: { readonly start: number; readonly end: number; readonly text: string }
              readonly snapshot: {
                readonly id: string
                readonly name: string
                readonly description?: string
                readonly digest: string
                readonly source: {
                  readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
                  readonly label: string
                }
                readonly content: string
                readonly status: "loaded"
              }
            }>
          }
          readonly delivery: "steer" | "queue"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.turn.settled"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly outcome: "completed" | "failed" | "cancelled"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.updated"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.generation.established"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly context: {
            readonly version: 1
            readonly generation: number
            readonly reason: "created" | "legacy-backfill" | "location-rebound" | "init"
            readonly locationRevision: number
            readonly environment: {
              readonly harness: "OpenCode Transit"
              readonly entrypoint: "opencode-transit"
              readonly targetKind: "local" | "rexd"
              readonly targetName: string
              readonly directory: string
              readonly projectRoot: string
              readonly vcs?: string
              readonly platform: string
            }
            readonly instructions: ReadonlyArray<{
              readonly id: string
              readonly origin: "global-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
              readonly scope: "global" | "project" | "nested"
              readonly source: string
              readonly declaredBy?: string
              readonly status: "loaded" | "ignored"
              readonly failureStage?: "discovery" | "read" | "fetch"
              readonly content?: string
              readonly digest?: string
            }>
            readonly digest: string
            readonly baseline: string
            readonly sources: {
              readonly [x: string]: {
                readonly value: JsonValue
                readonly baseline?: string
                readonly removed?: string
                readonly refresh?: "generation" | "activation"
              }
            }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.context.advanced"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly cause: "dynamic" | "nested-instructions" | "skill-catalog-reloaded"
          readonly text: string
          readonly sources: {
            readonly [x: string]: {
              readonly value: JsonValue
              readonly baseline?: string
              readonly removed?: string
              readonly refresh?: "generation" | "activation"
            }
          }
          readonly digest: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.synthetic"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly callID: string
          readonly command: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.shell.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly callID: string
          readonly output: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly agent: string
          readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
          readonly snapshot?: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly finish: string
          readonly cost: number
          readonly tokens: {
            readonly input: number
            readonly output: number
            readonly reasoning: number
            readonly cache: { readonly read: number; readonly write: number }
          }
          readonly snapshot?: string
          readonly files?: ReadonlyArray<string>
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.step.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.text.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly textID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly name: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.input.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly text: string
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.called"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly tool: string
          readonly input: { readonly [x: string]: JsonValue }
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.progress"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.success"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly structured: { readonly [x: string]: JsonValue }
          readonly content: ReadonlyArray<
            | { readonly type: "text"; readonly text: string }
            | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
          >
          readonly outputPaths?: ReadonlyArray<string>
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.tool.failed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly callID: string
          readonly error: { readonly type: "unknown"; readonly message: string }
          readonly result?: JsonValue
          readonly provider: {
            readonly executed: boolean
            readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.reasoning.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly assistantMessageID: string
          readonly reasoningID: string
          readonly text: string
          readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.retried"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly attempt: number
          readonly error: {
            readonly message: string
            readonly statusCode?: number
            readonly isRetryable: boolean
            readonly responseHeaders?: { readonly [x: string]: string }
            readonly responseBody?: string
            readonly metadata?: { readonly [x: string]: string }
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.started"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.compaction.ended"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly messageID: string
          readonly reason: "auto" | "manual"
          readonly text: string
          readonly recent: string
          readonly skills?: ReadonlyArray<{
            readonly id: string
            readonly name: string
            readonly description?: string
            readonly digest: string
            readonly source: {
              readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
              readonly label: string
            }
            readonly content: string
            readonly status: "loaded"
          }>
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.staged"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: {
          readonly timestamp: number
          readonly sessionID: string
          readonly revert: {
            readonly messageID: string
            readonly partID?: string
            readonly snapshot?: string
            readonly diff?: string
            readonly files?: ReadonlyArray<{
              readonly path: string
              readonly status: "added" | "modified" | "deleted"
              readonly additions: number
              readonly deletions: number
              readonly patch: string
            }>
          }
        }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.cleared"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: { readonly timestamp: number; readonly sessionID: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly type: "session.next.revert.committed"
        readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
        readonly location?: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
      }
  >
  readonly hasMore: boolean
}

export type SessionsEventsInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly after?: { readonly after?: number | undefined }["after"]
}

export type SessionsEventsOutput =
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.agent.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly agent: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.model.switched"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.moved"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly location: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly subdirectory?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.location.rebound"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly previous: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly location: {
          readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
          readonly directory: string
          readonly workspaceID?: string
          readonly lastKnownTargetName?: string
        }
        readonly revision: number
        readonly context?: {
          readonly version: 1
          readonly generation: number
          readonly reason: "created" | "legacy-backfill" | "location-rebound" | "init"
          readonly locationRevision: number
          readonly environment: {
            readonly harness: "OpenCode Transit"
            readonly entrypoint: "opencode-transit"
            readonly targetKind: "local" | "rexd"
            readonly targetName: string
            readonly directory: string
            readonly projectRoot: string
            readonly vcs?: string
            readonly platform: string
          }
          readonly instructions: ReadonlyArray<{
            readonly id: string
            readonly origin: "global-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
            readonly scope: "global" | "project" | "nested"
            readonly source: string
            readonly declaredBy?: string
            readonly status: "loaded" | "ignored"
            readonly failureStage?: "discovery" | "read" | "fetch"
            readonly content?: string
            readonly digest?: string
          }>
          readonly digest: string
          readonly baseline: string
          readonly sources: {
            readonly [x: string]: {
              readonly value: JsonValue
              readonly baseline?: string
              readonly removed?: string
              readonly refresh?: "generation" | "activation"
            }
          }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly invocations?: ReadonlyArray<{
            readonly source: { readonly start: number; readonly end: number; readonly text: string }
            readonly snapshot: {
              readonly id: string
              readonly name: string
              readonly description?: string
              readonly digest: string
              readonly source: {
                readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
                readonly label: string
              }
              readonly content: string
              readonly status: "loaded"
            }
          }>
        }
        readonly delivery: "steer" | "queue"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.prompt.admitted"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly prompt: {
          readonly text: string
          readonly files?: ReadonlyArray<{
            readonly uri: string
            readonly mime: string
            readonly name?: string
            readonly description?: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly agents?: ReadonlyArray<{
            readonly name: string
            readonly source?: { readonly start: number; readonly end: number; readonly text: string }
          }>
          readonly invocations?: ReadonlyArray<{
            readonly source: { readonly start: number; readonly end: number; readonly text: string }
            readonly snapshot: {
              readonly id: string
              readonly name: string
              readonly description?: string
              readonly digest: string
              readonly source: {
                readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
                readonly label: string
              }
              readonly content: string
              readonly status: "loaded"
            }
          }>
        }
        readonly delivery: "steer" | "queue"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.turn.settled"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly outcome: "completed" | "failed" | "cancelled"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.updated"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.generation.established"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly context: {
          readonly version: 1
          readonly generation: number
          readonly reason: "created" | "legacy-backfill" | "location-rebound" | "init"
          readonly locationRevision: number
          readonly environment: {
            readonly harness: "OpenCode Transit"
            readonly entrypoint: "opencode-transit"
            readonly targetKind: "local" | "rexd"
            readonly targetName: string
            readonly directory: string
            readonly projectRoot: string
            readonly vcs?: string
            readonly platform: string
          }
          readonly instructions: ReadonlyArray<{
            readonly id: string
            readonly origin: "global-file" | "project-file" | "configured-file" | "configured-url" | "nested-file"
            readonly scope: "global" | "project" | "nested"
            readonly source: string
            readonly declaredBy?: string
            readonly status: "loaded" | "ignored"
            readonly failureStage?: "discovery" | "read" | "fetch"
            readonly content?: string
            readonly digest?: string
          }>
          readonly digest: string
          readonly baseline: string
          readonly sources: {
            readonly [x: string]: {
              readonly value: JsonValue
              readonly baseline?: string
              readonly removed?: string
              readonly refresh?: "generation" | "activation"
            }
          }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.context.advanced"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly cause: "dynamic" | "nested-instructions" | "skill-catalog-reloaded"
        readonly text: string
        readonly sources: {
          readonly [x: string]: {
            readonly value: JsonValue
            readonly baseline?: string
            readonly removed?: string
            readonly refresh?: "generation" | "activation"
          }
        }
        readonly digest: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.synthetic"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly callID: string
        readonly command: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.shell.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly callID: string
        readonly output: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly snapshot?: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly finish: string
        readonly cost: number
        readonly tokens: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly snapshot?: string
        readonly files?: ReadonlyArray<string>
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.step.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.text.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly textID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly name: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.input.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly text: string
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.called"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly tool: string
        readonly input: { readonly [x: string]: unknown }
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.progress"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.success"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly structured: { readonly [x: string]: unknown }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly text: string }
          | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
        >
        readonly outputPaths?: ReadonlyArray<string>
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.tool.failed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly callID: string
        readonly error: { readonly type: "unknown"; readonly message: string }
        readonly result?: unknown
        readonly provider: {
          readonly executed: boolean
          readonly metadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.reasoning.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly assistantMessageID: string
        readonly reasoningID: string
        readonly text: string
        readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: unknown } }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.retried"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly attempt: number
        readonly error: {
          readonly message: string
          readonly statusCode?: number
          readonly isRetryable: boolean
          readonly responseHeaders?: { readonly [x: string]: string }
          readonly responseBody?: string
          readonly metadata?: { readonly [x: string]: string }
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.started"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.compaction.ended"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly messageID: string
        readonly reason: "auto" | "manual"
        readonly text: string
        readonly recent: string
        readonly skills?: ReadonlyArray<{
          readonly id: string
          readonly name: string
          readonly description?: string
          readonly digest: string
          readonly source: {
            readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
            readonly label: string
          }
          readonly content: string
          readonly status: "loaded"
        }>
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.staged"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: {
        readonly timestamp: number
        readonly sessionID: string
        readonly revert: {
          readonly messageID: string
          readonly partID?: string
          readonly snapshot?: string
          readonly diff?: string
          readonly files?: ReadonlyArray<{
            readonly path: string
            readonly status: "added" | "modified" | "deleted"
            readonly additions: number
            readonly deletions: number
            readonly patch: string
          }>
        }
      }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.cleared"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: { readonly timestamp: number; readonly sessionID: string }
    }
  | {
      readonly id: string
      readonly metadata?: { readonly [x: string]: unknown }
      readonly type: "session.next.revert.committed"
      readonly durable?: { readonly aggregateID: string; readonly seq: number; readonly version: number }
      readonly location?: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly data: { readonly timestamp: number; readonly sessionID: string; readonly messageID: string }
    }

export type SessionsInterruptInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type SessionsInterruptOutput = void

export type SessionsMessageInput = {
  readonly sessionID: { readonly sessionID: string; readonly messageID: string }["sessionID"]
  readonly messageID: { readonly sessionID: string; readonly messageID: string }["messageID"]
}

export type SessionsMessageOutput = {
  readonly data:
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly skills?: ReadonlyArray<{
          readonly source: { readonly start: number; readonly end: number; readonly text: string }
          readonly snapshot: {
            readonly id: string
            readonly name: string
            readonly description?: string
            readonly digest: string
            readonly source: {
              readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
              readonly label: string
            }
            readonly content: string
            readonly status: "loaded"
          }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly skills?: ReadonlyArray<{
          readonly id: string
          readonly name: string
          readonly description?: string
          readonly digest: string
          readonly source: {
            readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
            readonly label: string
          }
          readonly content: string
          readonly status: "loaded"
        }>
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
}["data"]

export type MessagesListInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly limit?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["limit"]
  readonly order?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["order"]
  readonly cursor?: {
    readonly limit?: number | undefined
    readonly order?: "asc" | "desc" | undefined
    readonly cursor?: string | undefined
  }["cursor"]
}

export type MessagesListOutput = {
  readonly data: ReadonlyArray<
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "agent-switched"
        readonly agent: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "model-switched"
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly text: string
        readonly files?: ReadonlyArray<{
          readonly uri: string
          readonly mime: string
          readonly name?: string
          readonly description?: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly agents?: ReadonlyArray<{
          readonly name: string
          readonly source?: { readonly start: number; readonly end: number; readonly text: string }
        }>
        readonly skills?: ReadonlyArray<{
          readonly source: { readonly start: number; readonly end: number; readonly text: string }
          readonly snapshot: {
            readonly id: string
            readonly name: string
            readonly description?: string
            readonly digest: string
            readonly source: {
              readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
              readonly label: string
            }
            readonly content: string
            readonly status: "loaded"
          }
        }>
        readonly type: "user"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly sessionID: string
        readonly text: string
        readonly type: "synthetic"
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
        readonly type: "system"
        readonly text: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "shell"
        readonly callID: string
        readonly command: string
        readonly output: string
      }
    | {
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number; readonly completed?: number }
        readonly type: "assistant"
        readonly agent: string
        readonly model: { readonly id: string; readonly providerID: string; readonly variant?: string }
        readonly content: ReadonlyArray<
          | { readonly type: "text"; readonly id: string; readonly text: string }
          | {
              readonly type: "reasoning"
              readonly id: string
              readonly text: string
              readonly providerMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              readonly time?: { readonly created: number; readonly completed?: number }
            }
          | {
              readonly type: "tool"
              readonly id: string
              readonly name: string
              readonly provider?: {
                readonly executed: boolean
                readonly metadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
                readonly resultMetadata?: { readonly [x: string]: { readonly [x: string]: JsonValue } }
              }
              readonly state:
                | { readonly status: "pending"; readonly input: string }
                | {
                    readonly status: "running"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                  }
                | {
                    readonly status: "completed"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly attachments?: ReadonlyArray<{
                      readonly uri: string
                      readonly mime: string
                      readonly name?: string
                      readonly description?: string
                      readonly source?: { readonly start: number; readonly end: number; readonly text: string }
                    }>
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly outputPaths?: ReadonlyArray<string>
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly result?: JsonValue
                  }
                | {
                    readonly status: "error"
                    readonly input: { readonly [x: string]: JsonValue }
                    readonly content: ReadonlyArray<
                      | { readonly type: "text"; readonly text: string }
                      | { readonly type: "file"; readonly uri: string; readonly mime: string; readonly name?: string }
                    >
                    readonly structured: { readonly [x: string]: JsonValue }
                    readonly error: { readonly type: "unknown"; readonly message: string }
                    readonly result?: JsonValue
                  }
              readonly time: {
                readonly created: number
                readonly ran?: number
                readonly completed?: number
                readonly pruned?: number
              }
            }
        >
        readonly snapshot?: { readonly start?: string; readonly end?: string; readonly files?: ReadonlyArray<string> }
        readonly finish?: string
        readonly cost?: number
        readonly tokens?: {
          readonly input: number
          readonly output: number
          readonly reasoning: number
          readonly cache: { readonly read: number; readonly write: number }
        }
        readonly error?: { readonly type: "unknown"; readonly message: string }
      }
    | {
        readonly type: "compaction"
        readonly reason: "auto" | "manual"
        readonly summary: string
        readonly recent: string
        readonly skills?: ReadonlyArray<{
          readonly id: string
          readonly name: string
          readonly description?: string
          readonly digest: string
          readonly source: {
            readonly kind: "built-in" | "opencode-global" | "opencode-project" | "imported" | "url"
            readonly label: string
          }
          readonly content: string
          readonly status: "loaded"
        }>
        readonly id: string
        readonly metadata?: { readonly [x: string]: JsonValue }
        readonly time: { readonly created: number }
      }
  >
  readonly cursor: { readonly previous?: string | null; readonly next?: string | null }
}

export type ModelsListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type ModelsListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly providerID: string
    readonly family?: string
    readonly name: string
    readonly api:
      | {
          readonly id: string
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | {
          readonly id: string
          readonly type: "native"
          readonly url?: string
          readonly settings: { readonly [x: string]: JsonValue }
        }
    readonly capabilities: {
      readonly tools: boolean
      readonly input: ReadonlyArray<string>
      readonly output: ReadonlyArray<string>
    }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
      readonly variant?: string
    }
    readonly variants: ReadonlyArray<{
      readonly id: string
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }>
    readonly time: { readonly released: number }
    readonly cost: ReadonlyArray<{
      readonly tier?: { readonly type: "context"; readonly size: number }
      readonly input: number
      readonly output: number
      readonly cache: { readonly read: number; readonly write: number }
    }>
    readonly status: "alpha" | "beta" | "deprecated" | "active"
    readonly enabled: boolean
    readonly limit: { readonly context: number; readonly input?: number; readonly output: number }
  }>
}

export type ProvidersListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type ProvidersListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly integrationID?: string
    readonly name: string
    readonly disabled?: boolean
    readonly api:
      | {
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | { readonly type: "native"; readonly url?: string; readonly settings: { readonly [x: string]: JsonValue } }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
  }>
}

export type ProvidersGetInput = {
  readonly providerID: { readonly providerID: string }["providerID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type ProvidersGetOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly integrationID?: string
    readonly name: string
    readonly disabled?: boolean
    readonly api:
      | {
          readonly type: "aisdk"
          readonly package: string
          readonly url?: string
          readonly settings?: { readonly [x: string]: JsonValue }
        }
      | { readonly type: "native"; readonly url?: string; readonly settings: { readonly [x: string]: JsonValue } }
    readonly request: {
      readonly headers: { readonly [x: string]: string }
      readonly body: { readonly [x: string]: JsonValue }
    }
  }
}

export type IntegrationsListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type IntegrationsListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<
      | {
          readonly id: string
          readonly type: "oauth"
          readonly label: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | { readonly type: "key"; readonly label?: string }
      | { readonly type: "env"; readonly names: ReadonlyArray<string> }
    >
    readonly connections: ReadonlyArray<
      | { readonly type: "credential"; readonly id: string; readonly label: string }
      | { readonly type: "env"; readonly name: string }
    >
  }>
}

export type IntegrationsGetInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type IntegrationsGetOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly name: string
    readonly methods: ReadonlyArray<
      | {
          readonly id: string
          readonly type: "oauth"
          readonly label: string
          readonly prompts?: ReadonlyArray<
            | {
                readonly type: "text"
                readonly key: string
                readonly message: string
                readonly placeholder?: string
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
            | {
                readonly type: "select"
                readonly key: string
                readonly message: string
                readonly options: ReadonlyArray<{
                  readonly label: string
                  readonly value: string
                  readonly hint?: string
                }>
                readonly when?: { readonly key: string; readonly op: "eq" | "neq"; readonly value: string }
              }
          >
        }
      | { readonly type: "key"; readonly label?: string }
      | { readonly type: "env"; readonly names: ReadonlyArray<string> }
    >
    readonly connections: ReadonlyArray<
      | { readonly type: "credential"; readonly id: string; readonly label: string }
      | { readonly type: "env"; readonly name: string }
    >
  } | null
}

export type IntegrationsConnectKeyInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly key: { readonly key: string; readonly label?: string | undefined }["key"]
  readonly label?: { readonly key: string; readonly label?: string | undefined }["label"]
}

export type IntegrationsConnectKeyOutput = void

export type IntegrationsConnectOauthInput = {
  readonly integrationID: { readonly integrationID: string }["integrationID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly methodID: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["methodID"]
  readonly inputs: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["inputs"]
  readonly label?: {
    readonly methodID: string
    readonly inputs: { readonly [x: string]: string }
    readonly label?: string | undefined
  }["label"]
}

export type IntegrationsConnectOauthOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly attemptID: string
    readonly url: string
    readonly instructions: string
    readonly mode: "auto" | "code"
    readonly time: {
      readonly created: number | "Infinity" | "-Infinity" | "NaN"
      readonly expires: number | "Infinity" | "-Infinity" | "NaN"
    }
  }
}

export type IntegrationsAttemptStatusInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type IntegrationsAttemptStatusOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | {
        readonly status: "pending"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "complete"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "failed"
        readonly message: string
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
    | {
        readonly status: "expired"
        readonly time: {
          readonly created: number | "Infinity" | "-Infinity" | "NaN"
          readonly expires: number | "Infinity" | "-Infinity" | "NaN"
        }
      }
}

export type IntegrationsAttemptCompleteInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly code?: { readonly code?: string | undefined }["code"]
}

export type IntegrationsAttemptCompleteOutput = void

export type IntegrationsAttemptCancelInput = {
  readonly attemptID: { readonly attemptID: string }["attemptID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type IntegrationsAttemptCancelOutput = void

export type CredentialsUpdateInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly label: { readonly label: string }["label"]
}

export type CredentialsUpdateOutput = void

export type CredentialsRemoveInput = {
  readonly credentialID: { readonly credentialID: string }["credentialID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type CredentialsRemoveOutput = void

export type PermissionsListRequestsInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type PermissionsListRequestsOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }>
}

export type PermissionsListSavedInput = {
  readonly projectID?: { readonly projectID?: string | undefined }["projectID"]
}

export type PermissionsListSavedOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly projectID: string
    readonly action: string
    readonly resource: string
  }>
}["data"]

export type PermissionsRemoveSavedInput = { readonly id: { readonly id: string }["id"] }

export type PermissionsRemoveSavedOutput = void

export type PermissionsCreateInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly id?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["id"]
  readonly action: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["action"]
  readonly resources: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["resources"]
  readonly save?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["save"]
  readonly metadata?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["metadata"]
  readonly source?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["source"]
  readonly agent?: {
    readonly id?: string | null
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
    readonly agent?: string | null
  }["agent"]
}

export type PermissionsCreateOutput = {
  readonly data: { readonly id: string; readonly effect: "allow" | "deny" | "ask" }
}["data"]

export type PermissionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type PermissionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type PermissionsGetInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type PermissionsGetOutput = {
  readonly data: {
    readonly id: string
    readonly sessionID: string
    readonly action: string
    readonly resources: ReadonlyArray<string>
    readonly save?: ReadonlyArray<string>
    readonly metadata?: { readonly [x: string]: JsonValue }
    readonly source?: { readonly type: "tool"; readonly messageID: string; readonly callID: string }
  }
}["data"]

export type PermissionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly reply: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["reply"]
  readonly message?: { readonly reply: "once" | "always" | "reject"; readonly message?: string | undefined }["message"]
}

export type PermissionsReplyOutput = void

export type FilesDirectoryStatusInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly path: { readonly path: string }["path"]
}

export type FilesDirectoryStatusOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: { readonly status: "directory" | "missing" | "not-directory"; readonly path: string }
}

export type FilesEnsureDirectoryInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly path: { readonly path: string }["path"]
}

export type FilesEnsureDirectoryOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: { readonly status: "directory" | "missing" | "not-directory"; readonly path: string }
}

export type FilesListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly path?: string | undefined
  }["location"]
  readonly path?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly path?: string | undefined
  }["path"]
}

export type FilesListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type FilesFindInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["location"]
  readonly query: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["query"]
  readonly type?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["type"]
  readonly limit?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly query: string
    readonly type?: "file" | "directory" | undefined
    readonly limit?: number | undefined
  }["limit"]
}

export type FilesFindOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{ readonly path: string; readonly type: "file" | "directory" }>
}

export type CommandsListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type CommandsListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly template: string
    readonly description?: string
    readonly agent?: string
    readonly model?: { readonly id: string; readonly providerID: string; readonly variant?: string }
    readonly subtask?: boolean
  }>
}

export type SkillsListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type SkillsListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly description?: string
    readonly slash?: boolean
    readonly location: string
    readonly content: string
  }>
}

export type SkillsCatalogInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly forceReload?: "true" | "false" | undefined
    readonly includeInactive?: "true" | "false" | undefined
  }["location"]
  readonly forceReload?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly forceReload?: "true" | "false" | undefined
    readonly includeInactive?: "true" | "false" | undefined
  }["forceReload"]
  readonly includeInactive?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
    readonly forceReload?: "true" | "false" | undefined
    readonly includeInactive?: "true" | "false" | undefined
  }["includeInactive"]
}

export type SkillsCatalogOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly revision: string
    readonly skills: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly sourceLabel: string
      readonly digest: string
    }>
    readonly diagnostics: ReadonlyArray<{
      readonly kind:
        | "root-unavailable"
        | "scan-failed"
        | "path-escape"
        | "read-failed"
        | "invalid-frontmatter"
        | "invalid-name"
        | "invalid-description"
        | "legacy-layout"
        | "name-mismatch"
        | "duplicate-name"
        | "invalid-settings"
        | "missing-target"
        | "project-target-scope-ignored"
      readonly severity: "error" | "warning"
      readonly sourceLabel: string
      readonly message: string
      readonly path?: string
      readonly skillID?: string
    }>
    readonly digest: string
  }
}

export type SkillsReloadInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type SkillsReloadOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly revision: string
    readonly skills: ReadonlyArray<{
      readonly id: string
      readonly name: string
      readonly description?: string
      readonly sourceLabel: string
      readonly digest: string
    }>
    readonly diagnostics: ReadonlyArray<{
      readonly kind:
        | "root-unavailable"
        | "scan-failed"
        | "path-escape"
        | "read-failed"
        | "invalid-frontmatter"
        | "invalid-name"
        | "invalid-description"
        | "legacy-layout"
        | "name-mismatch"
        | "duplicate-name"
        | "invalid-settings"
        | "missing-target"
        | "project-target-scope-ignored"
      readonly severity: "error" | "warning"
      readonly sourceLabel: string
      readonly message: string
      readonly path?: string
      readonly skillID?: string
    }>
    readonly digest: string
  }
}

export type SkillsSettingsOutput = {
  readonly path: string
  readonly revision: string
  readonly roots: ReadonlyArray<{
    readonly kind: "opencode-global" | "imported" | "url"
    readonly value: string
    readonly resolved?: string
    readonly default: boolean
    readonly status: "ready" | "undetected" | "unavailable" | "configured"
  }>
  readonly targets: { readonly [x: string]: "*" | ReadonlyArray<"local" | string> }
  readonly diagnostics: ReadonlyArray<{
    readonly kind: "invalid-config" | "invalid-path" | "invalid-url" | "duplicate-root" | "missing-target"
    readonly severity: "error" | "warning"
    readonly field: string
    readonly message: string
    readonly skillID?: string
    readonly targetID?: string
  }>
  readonly valid: boolean
}

export type SkillsDiscoveryUpdateInput = {
  readonly paths: {
    readonly paths: ReadonlyArray<string>
    readonly urls: ReadonlyArray<string>
    readonly expectedRevision: string
  }["paths"]
  readonly urls: {
    readonly paths: ReadonlyArray<string>
    readonly urls: ReadonlyArray<string>
    readonly expectedRevision: string
  }["urls"]
  readonly expectedRevision: {
    readonly paths: ReadonlyArray<string>
    readonly urls: ReadonlyArray<string>
    readonly expectedRevision: string
  }["expectedRevision"]
}

export type SkillsDiscoveryUpdateOutput = {
  readonly path: string
  readonly revision: string
  readonly roots: ReadonlyArray<{
    readonly kind: "opencode-global" | "imported" | "url"
    readonly value: string
    readonly resolved?: string
    readonly default: boolean
    readonly status: "ready" | "undetected" | "unavailable" | "configured"
  }>
  readonly targets: { readonly [x: string]: "*" | ReadonlyArray<"local" | string> }
  readonly diagnostics: ReadonlyArray<{
    readonly kind: "invalid-config" | "invalid-path" | "invalid-url" | "duplicate-root" | "missing-target"
    readonly severity: "error" | "warning"
    readonly field: string
    readonly message: string
    readonly skillID?: string
    readonly targetID?: string
  }>
  readonly valid: boolean
}

export type SkillsDiscoveryResetInput = {
  readonly expectedRevision: { readonly expectedRevision: string }["expectedRevision"]
}

export type SkillsDiscoveryResetOutput = {
  readonly path: string
  readonly revision: string
  readonly roots: ReadonlyArray<{
    readonly kind: "opencode-global" | "imported" | "url"
    readonly value: string
    readonly resolved?: string
    readonly default: boolean
    readonly status: "ready" | "undetected" | "unavailable" | "configured"
  }>
  readonly targets: { readonly [x: string]: "*" | ReadonlyArray<"local" | string> }
  readonly diagnostics: ReadonlyArray<{
    readonly kind: "invalid-config" | "invalid-path" | "invalid-url" | "duplicate-root" | "missing-target"
    readonly severity: "error" | "warning"
    readonly field: string
    readonly message: string
    readonly skillID?: string
    readonly targetID?: string
  }>
  readonly valid: boolean
}

export type SkillsTargetScopeUpdateInput = {
  readonly skillID: { readonly skillID: string }["skillID"]
  readonly scope: { readonly scope: "*" | ReadonlyArray<"local" | string>; readonly expectedRevision: string }["scope"]
  readonly expectedRevision: {
    readonly scope: "*" | ReadonlyArray<"local" | string>
    readonly expectedRevision: string
  }["expectedRevision"]
}

export type SkillsTargetScopeUpdateOutput = {
  readonly path: string
  readonly revision: string
  readonly roots: ReadonlyArray<{
    readonly kind: "opencode-global" | "imported" | "url"
    readonly value: string
    readonly resolved?: string
    readonly default: boolean
    readonly status: "ready" | "undetected" | "unavailable" | "configured"
  }>
  readonly targets: { readonly [x: string]: "*" | ReadonlyArray<"local" | string> }
  readonly diagnostics: ReadonlyArray<{
    readonly kind: "invalid-config" | "invalid-path" | "invalid-url" | "duplicate-root" | "missing-target"
    readonly severity: "error" | "warning"
    readonly field: string
    readonly message: string
    readonly skillID?: string
    readonly targetID?: string
  }>
  readonly valid: boolean
}

export type EventsSubscribeOutput = OpenCodeEventEncoded

export type PtysListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type PtysListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
    readonly environmentGeneration?: number
    readonly environmentStale?: boolean
  }>
}

export type PtysCreateInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly sessionID?: {
    readonly sessionID?: string
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["sessionID"]
  readonly command?: {
    readonly sessionID?: string
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["command"]
  readonly args?: {
    readonly sessionID?: string
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["args"]
  readonly cwd?: {
    readonly sessionID?: string
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["cwd"]
  readonly title?: {
    readonly sessionID?: string
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["title"]
  readonly env?: {
    readonly sessionID?: string
    readonly command?: string
    readonly args?: ReadonlyArray<string>
    readonly cwd?: string
    readonly title?: string
    readonly env?: { readonly [x: string]: string }
  }["env"]
}

export type PtysCreateOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
    readonly environmentGeneration?: number
    readonly environmentStale?: boolean
  }
}

export type PtysGetInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type PtysGetOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
    readonly environmentGeneration?: number
    readonly environmentStale?: boolean
  }
}

export type PtysUpdateInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly title?: {
    readonly title?: string
    readonly size?: { readonly rows: number; readonly cols: number }
  }["title"]
  readonly size?: { readonly title?: string; readonly size?: { readonly rows: number; readonly cols: number } }["size"]
}

export type PtysUpdateOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
    readonly environmentGeneration?: number
    readonly environmentStale?: boolean
  }
}

export type PtysRestartInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly sessionID?: { readonly sessionID?: string }["sessionID"]
}

export type PtysRestartOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly id: string
    readonly title: string
    readonly command: string
    readonly args: ReadonlyArray<string>
    readonly cwd: string
    readonly status: "running" | "exited"
    readonly pid: number
    readonly exitCode?: number
    readonly environmentGeneration?: number
    readonly environmentStale?: boolean
  }
}

export type PtysRemoveInput = {
  readonly ptyID: { readonly ptyID: string }["ptyID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type PtysRemoveOutput = void

export type QuestionsListRequestsInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type QuestionsListRequestsOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}

export type QuestionsListInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type QuestionsListOutput = {
  readonly data: ReadonlyArray<{
    readonly id: string
    readonly sessionID: string
    readonly questions: ReadonlyArray<{
      readonly question: string
      readonly header: string
      readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>
      readonly multiple?: boolean
      readonly custom?: boolean
    }>
    readonly tool?: { readonly messageID: string; readonly callID: string }
  }>
}["data"]

export type QuestionsReplyInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
  readonly answers: { readonly answers: ReadonlyArray<ReadonlyArray<string>> }["answers"]
}

export type QuestionsReplyOutput = void

export type QuestionsRejectInput = {
  readonly sessionID: { readonly sessionID: string; readonly requestID: string }["sessionID"]
  readonly requestID: { readonly sessionID: string; readonly requestID: string }["requestID"]
}

export type QuestionsRejectOutput = void

export type ReferencesListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type ReferencesListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: ReadonlyArray<{
    readonly name: string
    readonly path: string
    readonly description?: string
    readonly hidden?: boolean
    readonly source:
      | { readonly type: "local"; readonly path: string; readonly description?: string; readonly hidden?: boolean }
      | {
          readonly type: "git"
          readonly repository: string
          readonly branch?: string
          readonly description?: string
          readonly hidden?: boolean
        }
  }>
}

export type ProjectCopiesCreateInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly strategy: { readonly strategy: string; readonly directory: string; readonly name?: string }["strategy"]
  readonly directory: { readonly strategy: string; readonly directory: string; readonly name?: string }["directory"]
  readonly name?: { readonly strategy: string; readonly directory: string; readonly name?: string }["name"]
}

export type ProjectCopiesCreateOutput = { readonly directory: string }

export type ProjectCopiesRemoveInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly directory: { readonly directory: string; readonly force: boolean }["directory"]
  readonly force: { readonly directory: string; readonly force: boolean }["force"]
}

export type ProjectCopiesRemoveOutput = void

export type ProjectCopiesRefreshInput = {
  readonly projectID: { readonly projectID: string }["projectID"]
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type ProjectCopiesRefreshOutput = void

export type TargetsListOutput = {
  readonly path: string
  readonly revision: string
  readonly targets: ReadonlyArray<{
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }>
  readonly diagnostics: ReadonlyArray<{
    readonly severity: "error" | "warning"
    readonly path: string
    readonly message: string
    readonly offset?: number | undefined
  }>
  readonly valid: boolean
}

export type TargetsResolveSessionInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type TargetsResolveSessionOutput =
  | {
      readonly status: "resolved"
      readonly location: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly target?: {
        readonly id: string
        readonly status: "unverified"
        readonly health?:
          | {
              readonly status: "ready"
              readonly stages: ReadonlyArray<
                "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
              >
              readonly checkedAt: number | "Infinity" | "-Infinity" | "NaN"
              readonly trustedUntil: number | "Infinity" | "-Infinity" | "NaN"
            }
          | {
              readonly status: "unavailable" | "invalid"
              readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
              readonly message: string
              readonly checkedAt: number | "Infinity" | "-Infinity" | "NaN"
              readonly trustedUntil: number | "Infinity" | "-Infinity" | "NaN"
            }
          | null
        readonly name: string
        readonly transport: "ssh"
        readonly connection:
          | { readonly type: "ssh-config"; readonly host: string }
          | {
              readonly type: "manual"
              readonly host: string
              readonly user: string
              readonly port: number | "Infinity" | "-Infinity" | "NaN"
              readonly identityFile?: string | null
            }
        readonly defaultDirectory?: string | null
        readonly workspaceRoots: ReadonlyArray<string>
        readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | null
        readonly skillStagingRoot?: string | null
      } | null
    }
  | {
      readonly status: "missing_local_target"
      readonly location: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly missingTargetID: string
      readonly lastKnownTargetName?: string | null
      readonly referencedSessionIDs: ReadonlyArray<string>
    }
  | {
      readonly status: "unbound_portable_target"
      readonly portableTargetLabel: string
      readonly directory: string
      readonly referencedSessionIDs: ReadonlyArray<string>
    }
  | {
      readonly status: "target_unavailable"
      readonly location: {
        readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
        readonly directory: string
        readonly workspaceID?: string
        readonly lastKnownTargetName?: string
      }
      readonly target: {
        readonly id: string
        readonly status: "unverified"
        readonly health?:
          | {
              readonly status: "ready"
              readonly stages: ReadonlyArray<
                "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
              >
              readonly checkedAt: number | "Infinity" | "-Infinity" | "NaN"
              readonly trustedUntil: number | "Infinity" | "-Infinity" | "NaN"
            }
          | {
              readonly status: "unavailable" | "invalid"
              readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
              readonly message: string
              readonly checkedAt: number | "Infinity" | "-Infinity" | "NaN"
              readonly trustedUntil: number | "Infinity" | "-Infinity" | "NaN"
            }
          | null
        readonly name: string
        readonly transport: "ssh"
        readonly connection:
          | { readonly type: "ssh-config"; readonly host: string }
          | {
              readonly type: "manual"
              readonly host: string
              readonly user: string
              readonly port: number | "Infinity" | "-Infinity" | "NaN"
              readonly identityFile?: string | null
            }
        readonly defaultDirectory?: string | null
        readonly workspaceRoots: ReadonlyArray<string>
        readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | null
        readonly skillStagingRoot?: string | null
      }
      readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
      readonly message: string
    }
  | { readonly status: "resolution_failed"; readonly message: string }

export type TargetsBindingListOutput = {
  readonly revision: string
  readonly bindings: { readonly [x: string]: string }
}

export type TargetsBindPortableInput = {
  readonly portableTargetLabel: { readonly portableTargetLabel: string }["portableTargetLabel"]
  readonly targetID: {
    readonly targetID: string
    readonly expectedRevision: string
    readonly expectedSessionIDs: ReadonlyArray<string>
  }["targetID"]
  readonly expectedRevision: {
    readonly targetID: string
    readonly expectedRevision: string
    readonly expectedSessionIDs: ReadonlyArray<string>
  }["expectedRevision"]
  readonly expectedSessionIDs: {
    readonly targetID: string
    readonly expectedRevision: string
    readonly expectedSessionIDs: ReadonlyArray<string>
  }["expectedSessionIDs"]
}

export type TargetsBindPortableOutput = {
  readonly revision: string
  readonly bindings: { readonly [x: string]: string }
  readonly resolvedSessionIDs: ReadonlyArray<string>
  readonly failedSessionIDs: ReadonlyArray<string>
}

export type TargetsUnbindPortableInput = {
  readonly portableTargetLabel: { readonly portableTargetLabel: string }["portableTargetLabel"]
  readonly expectedRevision: {
    readonly expectedRevision: string
    readonly expectedSessionIDs: ReadonlyArray<string>
  }["expectedRevision"]
  readonly expectedSessionIDs: {
    readonly expectedRevision: string
    readonly expectedSessionIDs: ReadonlyArray<string>
  }["expectedSessionIDs"]
}

export type TargetsUnbindPortableOutput = {
  readonly revision: string
  readonly bindings: { readonly [x: string]: string }
}

export type TargetsRebindSessionInput = {
  readonly sessionID: { readonly sessionID: string }["sessionID"]
  readonly expectedRevision: {
    readonly expectedRevision: number | "Infinity" | "-Infinity" | "NaN"
    readonly destination: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    }
  }["expectedRevision"]
  readonly destination: {
    readonly expectedRevision: number | "Infinity" | "-Infinity" | "NaN"
    readonly destination: {
      readonly target?: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
      readonly directory: string
      readonly workspaceID?: string
      readonly lastKnownTargetName?: string
    }
  }["destination"]
}

export type TargetsRebindSessionOutput = {
  readonly status: "unchanged" | "rebound"
  readonly revision: number
  readonly warnings: ReadonlyArray<string>
}

export type TargetsInspectInput = {
  readonly input: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
  }["input"]
}

export type TargetsInspectOutput = { readonly home: string }

export type TargetsCompleteInput = {
  readonly input: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly value: string
    readonly cursor: number
    readonly cwd: string
  }["input"]
  readonly value: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly value: string
    readonly cursor: number
    readonly cwd: string
  }["value"]
  readonly cursor: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly value: string
    readonly cursor: number
    readonly cwd: string
  }["cursor"]
  readonly cwd: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly value: string
    readonly cursor: number
    readonly cwd: string
  }["cwd"]
}

export type TargetsCompleteOutput = {
  readonly value: string
  readonly cursor: number
  readonly candidates: ReadonlyArray<string>
}

export type TargetsCreateInput = {
  readonly input: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly expectedRevision: string
  }["input"]
  readonly expectedRevision: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly expectedRevision: string
  }["expectedRevision"]
}

export type TargetsCreateOutput = {
  readonly target: {
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }
  readonly snapshot: {
    readonly path: string
    readonly revision: string
    readonly targets: ReadonlyArray<{
      readonly id: string
      readonly status: "unverified"
      readonly health?:
        | {
            readonly status: "ready"
            readonly stages: ReadonlyArray<
              "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            >
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | {
            readonly status: "unavailable" | "invalid"
            readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            readonly message: string
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | undefined
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }>
    readonly diagnostics: ReadonlyArray<{
      readonly severity: "error" | "warning"
      readonly path: string
      readonly message: string
      readonly offset?: number | undefined
    }>
    readonly valid: boolean
  }
}

export type TargetsUpdateInput = {
  readonly targetID: { readonly targetID: string }["targetID"]
  readonly input: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly expectedRevision: string
  }["input"]
  readonly expectedRevision: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly expectedRevision: string
  }["expectedRevision"]
}

export type TargetsUpdateOutput = {
  readonly target: {
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }
  readonly snapshot: {
    readonly path: string
    readonly revision: string
    readonly targets: ReadonlyArray<{
      readonly id: string
      readonly status: "unverified"
      readonly health?:
        | {
            readonly status: "ready"
            readonly stages: ReadonlyArray<
              "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            >
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | {
            readonly status: "unavailable" | "invalid"
            readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            readonly message: string
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | undefined
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }>
    readonly diagnostics: ReadonlyArray<{
      readonly severity: "error" | "warning"
      readonly path: string
      readonly message: string
      readonly offset?: number | undefined
    }>
    readonly valid: boolean
  }
}

export type TargetsRemoveInput = {
  readonly targetID: { readonly targetID: string }["targetID"]
  readonly expectedRevision: { readonly expectedRevision: string }["expectedRevision"]
}

export type TargetsRemoveOutput = {
  readonly path: string
  readonly revision: string
  readonly targets: ReadonlyArray<{
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }>
  readonly diagnostics: ReadonlyArray<{
    readonly severity: "error" | "warning"
    readonly path: string
    readonly message: string
    readonly offset?: number | undefined
  }>
  readonly valid: boolean
}

export type TargetsRestoreInput = {
  readonly targetID: { readonly targetID: string }["targetID"]
  readonly input: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly referencedSessionIDs: ReadonlyArray<string>
    readonly expectedRevision: string
  }["input"]
  readonly referencedSessionIDs: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly referencedSessionIDs: ReadonlyArray<string>
    readonly expectedRevision: string
  }["referencedSessionIDs"]
  readonly expectedRevision: {
    readonly input: {
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }
    readonly referencedSessionIDs: ReadonlyArray<string>
    readonly expectedRevision: string
  }["expectedRevision"]
}

export type TargetsRestoreOutput = {
  readonly target: {
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }
  readonly snapshot: {
    readonly path: string
    readonly revision: string
    readonly targets: ReadonlyArray<{
      readonly id: string
      readonly status: "unverified"
      readonly health?:
        | {
            readonly status: "ready"
            readonly stages: ReadonlyArray<
              "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            >
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | {
            readonly status: "unavailable" | "invalid"
            readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            readonly message: string
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | undefined
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }>
    readonly diagnostics: ReadonlyArray<{
      readonly severity: "error" | "warning"
      readonly path: string
      readonly message: string
      readonly offset?: number | undefined
    }>
    readonly valid: boolean
  }
  readonly resolvedSessionIDs: ReadonlyArray<string>
  readonly failedSessionIDs: ReadonlyArray<string>
}

export type TargetsTestConnectionInput = { readonly targetID: { readonly targetID: string }["targetID"] }

export type TargetsTestConnectionOutput =
  | {
      readonly status: "ready"
      readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
      readonly checkedAt: number
      readonly trustedUntil: number
    }
  | {
      readonly status: "unavailable" | "invalid"
      readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
      readonly message: string
      readonly checkedAt: number
      readonly trustedUntil: number
    }

export type TargetsRefreshInput = { readonly targetID: { readonly targetID: string }["targetID"] }

export type TargetsRefreshOutput =
  | {
      readonly status: "ready"
      readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
      readonly checkedAt: number
      readonly trustedUntil: number
    }
  | {
      readonly status: "unavailable" | "invalid"
      readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
      readonly message: string
      readonly checkedAt: number
      readonly trustedUntil: number
    }

export type TargetsPrepareInput = { readonly targetID: { readonly targetID: string }["targetID"] }

export type TargetsPrepareOutput =
  | {
      readonly status: "ready"
      readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
      readonly checkedAt: number
      readonly trustedUntil: number
    }
  | {
      readonly status: "unavailable" | "invalid"
      readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
      readonly message: string
      readonly checkedAt: number
      readonly trustedUntil: number
    }

export type TargetsPreviewLegacyImportOutput = {
  readonly source: string
  readonly sourceRevision: string
  readonly candidates: ReadonlyArray<{
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }>
  readonly diagnostics: ReadonlyArray<{
    readonly severity: "error" | "warning"
    readonly path: string
    readonly message: string
    readonly offset?: number | undefined
  }>
}

export type TargetsImportLegacyInput = {
  readonly sourceRevision: { readonly sourceRevision: string; readonly expectedRevision: string }["sourceRevision"]
  readonly expectedRevision: { readonly sourceRevision: string; readonly expectedRevision: string }["expectedRevision"]
}

export type TargetsImportLegacyOutput = {
  readonly imported: ReadonlyArray<{
    readonly id: string
    readonly status: "unverified"
    readonly health?:
      | {
          readonly status: "ready"
          readonly stages: ReadonlyArray<"ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory">
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | {
          readonly status: "unavailable" | "invalid"
          readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
          readonly message: string
          readonly checkedAt: number
          readonly trustedUntil: number
        }
      | undefined
    readonly name: string
    readonly transport: "ssh"
    readonly connection:
      | { readonly type: "ssh-config"; readonly host: string }
      | {
          readonly type: "manual"
          readonly host: string
          readonly user: string
          readonly port: number
          readonly identityFile?: string | undefined
        }
    readonly defaultDirectory?: string | undefined
    readonly workspaceRoots: ReadonlyArray<string>
    readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
    readonly skillStagingRoot?: string | undefined
  }>
  readonly snapshot: {
    readonly path: string
    readonly revision: string
    readonly targets: ReadonlyArray<{
      readonly id: string
      readonly status: "unverified"
      readonly health?:
        | {
            readonly status: "ready"
            readonly stages: ReadonlyArray<
              "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            >
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | {
            readonly status: "unavailable" | "invalid"
            readonly stage: "ssh" | "environment" | "prepare" | "handshake" | "capabilities" | "directory"
            readonly message: string
            readonly checkedAt: number
            readonly trustedUntil: number
          }
        | undefined
      readonly name: string
      readonly transport: "ssh"
      readonly connection:
        | { readonly type: "ssh-config"; readonly host: string }
        | {
            readonly type: "manual"
            readonly host: string
            readonly user: string
            readonly port: number
            readonly identityFile?: string | undefined
          }
      readonly defaultDirectory?: string | undefined
      readonly workspaceRoots: ReadonlyArray<string>
      readonly command?: { readonly program: string; readonly args: ReadonlyArray<string> } | undefined
      readonly skillStagingRoot?: string | undefined
    }>
    readonly diagnostics: ReadonlyArray<{
      readonly severity: "error" | "warning"
      readonly path: string
      readonly message: string
      readonly offset?: number | undefined
    }>
    readonly valid: boolean
  }
}

export type EnvironmentListInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type EnvironmentListOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly enabled: boolean
    readonly generation: number | "Infinity" | "-Infinity" | "NaN"
    readonly variables: ReadonlyArray<{
      readonly name: string
      readonly origin: "base" | "user" | "project" | "explicit"
      readonly source?: string | null
      readonly overrides: ReadonlyArray<"base" | "user" | "project" | "explicit">
    }>
    readonly sources: ReadonlyArray<{
      readonly path: string
      readonly origin: "user" | "project"
      readonly present: boolean
    }>
  }
}

export type EnvironmentReloadInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
}

export type EnvironmentReloadOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly enabled: boolean
    readonly generation: number | "Infinity" | "-Infinity" | "NaN"
    readonly variables: ReadonlyArray<{
      readonly name: string
      readonly origin: "base" | "user" | "project" | "explicit"
      readonly source?: string | null
      readonly overrides: ReadonlyArray<"base" | "user" | "project" | "explicit">
    }>
    readonly sources: ReadonlyArray<{
      readonly path: string
      readonly origin: "user" | "project"
      readonly present: boolean
    }>
  }
}

export type EnvironmentRevealInput = {
  readonly location?: {
    readonly location?:
      | {
          readonly directory?: string | undefined
          readonly workspace?: string | undefined
          readonly target?: string | undefined
        }
      | undefined
  }["location"]
  readonly confirmed: { readonly confirmed: true }["confirmed"]
}

export type EnvironmentRevealOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data: {
    readonly generation: number | "Infinity" | "-Infinity" | "NaN"
    readonly values: { readonly [x: string]: string }
  }
}

export type EnvironmentInitInput = { readonly sessionID: { readonly sessionID: string }["sessionID"] }

export type EnvironmentInitOutput = {
  readonly location: {
    readonly target: { readonly type: "local" } | { readonly type: "rexd"; readonly targetID: string }
    readonly directory: string
    readonly workspaceID?: string
    readonly lastKnownTargetName?: string
    readonly project: { readonly id: string; readonly directory: string }
  }
  readonly data:
    | {
        readonly status: "completed"
        readonly template: "created" | "existing"
        readonly generation: number | "Infinity" | "-Infinity" | "NaN"
      }
    | { readonly status: "cancelled" | "failed"; readonly template: "created" | "existing" }
}
