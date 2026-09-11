import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { EventV2 } from "@opencode-ai/core/event"
import { EventManifest } from "@/event-manifest"
import { InstanceDisposed } from "@/server/event"
import "@opencode-ai/core/account"
import "@/server/event"
import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiError, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import semver from "semver"
import { described } from "./metadata"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { SyncControl } from "@opencode-ai/core/sync/control"
import { SyncDevice } from "@opencode-ai/core/sync/device"
import { SyncMetadata } from "@opencode-ai/core/sync/metadata"
import { SyncState } from "@opencode-ai/core/sync/state"
import { SyncSpace } from "@opencode-ai/core/sync/space"
import { SyncRuntime } from "@opencode-ai/core/sync/runtime"
import { BaiduAuth } from "@opencode-ai/core/sync/baidu-auth"
import { SyncRoot } from "@opencode-ai/core/sync/root"

const GlobalHealth = Schema.Struct({
  healthy: Schema.Literal(true),
  version: Schema.String,
})

const SyncEventSchemas = EventManifest.Latest.values()
  .flatMap((definition) => {
    if (!definition.durable) return []
    return [
      Schema.Struct({
        type: Schema.Literal("sync"),
        id: EventV2.ID,
        syncEvent: Schema.Struct({
          type: Schema.Literal(EventV2.versionedType(definition.type, definition.durable.version)),
          id: EventV2.ID,
          seq: Schema.Finite,
          aggregateID: Schema.String,
          data: definition.data,
        }),
      }).annotate({ identifier: `SyncEvent.${definition.type}` }),
    ]
  })
  .toArray()

const GlobalEventSchema = Schema.Struct({
  directory: Schema.String,
  project: Schema.optional(Schema.String),
  workspace: Schema.optional(Schema.String),
  payload: Schema.Union([
    ...EventManifest.Latest.values()
      .map((definition) =>
        Schema.Struct({ id: EventV2.ID, type: Schema.Literal(definition.type), properties: definition.data }),
      )
      .toArray(),
    InstanceDisposed,
    ...SyncEventSchemas,
  ]),
}).annotate({ identifier: "GlobalEvent" })

export const GlobalUpgradeInput = Schema.Struct({
  target: Schema.String.check(
    Schema.makeFilter((value) => (semver.valid(value) === null ? "Expected a semantic version" : undefined)),
  ),
})

const GlobalUpgradeResult = Schema.Union([
  Schema.Struct({
    success: Schema.Literal(true),
    version: Schema.String,
  }),
  Schema.Struct({
    success: Schema.Literal(false),
    error: Schema.String,
  }),
])

const SyncInitializeInput = Schema.Struct({ deviceName: Schema.NonEmptyString })
const SyncOAuthBeginResult = Schema.Struct({
  attemptID: Schema.NonEmptyString,
  authorizationURL: Schema.NonEmptyString,
  completion: SyncSetup.BeginInput.fields.completion,
})
const SyncSpaceEntry = Schema.Union([
  Schema.Struct({ status: Schema.Literal("compatible"), descriptor: SyncSpace.Descriptor }),
  Schema.Struct({ status: Schema.Literal("unsupported"), descriptor: SyncSpace.Descriptor }),
])
const SyncDiscovery = Schema.Struct({
  spaces: Schema.Array(SyncSpaceEntry),
  deletions: Schema.Array(SyncSpace.Deletion),
})
const SyncCreateResult = Schema.Struct({
  state: SyncState.State,
  descriptor: SyncSpace.Descriptor,
  recoveryString: Schema.optional(Schema.NonEmptyString),
})
const SyncNamespaceInput = Schema.Struct({ namespaceID: Schema.NonEmptyString })
const SyncEnabledInput = Schema.Struct({ enabled: Schema.Boolean })
const SyncIntervalInput = Schema.Struct({ intervalSeconds: SyncState.IntervalSeconds })

export const SyncMissingAppMessage = BaiduAuth.MISSING_APP_MESSAGE
export const SyncIncompatibleLocalStateMessage = SyncSetup.INCOMPATIBLE_LOCAL_STATE_MESSAGE

export class SyncSetupApiError extends Schema.ErrorClass<SyncSetupApiError>("SyncSetupApiError")(
  {
    name: Schema.Literal("SyncSetupError"),
    data: Schema.Struct({
      kind: Schema.Literals([
        "uninitialized",
        "unauthenticated",
        "account-mismatch",
        "invalid",
        "oauth",
        "missing-app",
        "missing-legacy",
        "incompatible-local-state",
        "remote",
        "storage",
        "locked",
        "remote-uninitialized",
        "incompatible-remote",
      ]),
      message: Schema.String,
      diagnostic: Schema.optional(SyncRuntime.Diagnostic),
    }),
  },
  { httpApiStatus: 400 },
) {}

export class SyncControlApiError extends Schema.ErrorClass<SyncControlApiError>("SyncControlApiError")(
  {
    name: Schema.Literal("SyncControlError"),
    data: Schema.Struct({
      kind: Schema.Literals([
        "unconfigured",
        "remote-uninitialized",
        "incompatible-remote",
        "locked",
        "provider",
        "storage",
        "invalid",
        "pending",
        "deleted",
      ]),
      diagnostic: Schema.optional(SyncRuntime.Diagnostic),
    }),
  },
  { httpApiStatus: 503 },
) {}

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  syncState: "/global/sync/state",
  syncInitialize: "/global/sync/initialize",
  syncOAuthBegin: "/global/sync/oauth/begin",
  syncOAuthComplete: "/global/sync/oauth/complete",
  syncOAuthSwitchAccount: "/global/sync/oauth/switch-account",
  syncLogout: "/global/sync/logout",
  syncSpaces: "/global/sync/spaces",
  syncSpaceJoin: "/global/sync/spaces/join",
  syncSpaceActivate: "/global/sync/spaces/activate",
  syncSpaceLeave: "/global/sync/spaces/leave",
  syncSpaceDelete: "/global/sync/spaces/:namespaceID",
  syncUnassigned: "/global/sync/unassigned",
  syncEnabled: "/global/sync/enabled",
  syncInterval: "/global/sync/interval",
  syncRemove: "/global/sync/device",
  syncStatus: "/global/sync/status",
  syncNow: "/global/sync/now",
  syncCloud: "/global/sync/cloud",
  syncCloudJoin: "/global/sync/cloud/join",
  syncSessions: "/global/sync/sessions",
  syncHydrate: "/global/sync/hydrate",
  syncSessionDelete: "/global/sync/sessions/delete",
  syncDevices: "/global/sync/devices",
  syncRecovery: "/global/sync/recovery-key",
} as const

export const GlobalApi = HttpApi.make("global").add(
  HttpApiGroup.make("global")
    .add(
      HttpApiEndpoint.get("health", GlobalPaths.health, {
        success: described(GlobalHealth, "Health information"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.health",
          summary: "Get health",
          description: "Get health information about the OpenCode server.",
        }),
      ),
      HttpApiEndpoint.get("event", GlobalPaths.event, {
        success: GlobalEventSchema,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.event",
          summary: "Get global events",
          description: "Subscribe to global events from the OpenCode system using server-sent events.",
        }),
      ),
      HttpApiEndpoint.get("configGet", GlobalPaths.config, {
        success: described(ConfigV1.Info, "Get global config info"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.get",
          summary: "Get global configuration",
          description: "Retrieve the current global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.get("syncState", GlobalPaths.syncState, {
        success: Schema.NullOr(SyncState.State),
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncInitialize", GlobalPaths.syncInitialize, {
        payload: SyncInitializeInput,
        success: SyncState.State,
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncOAuthBegin", GlobalPaths.syncOAuthBegin, {
        payload: SyncSetup.BeginInput,
        success: SyncOAuthBeginResult,
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncOAuthComplete", GlobalPaths.syncOAuthComplete, {
        payload: SyncSetup.CompleteInput,
        success: SyncState.State,
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncOAuthSwitchAccount", GlobalPaths.syncOAuthSwitchAccount, {
        payload: SyncSetup.CompleteInput,
        success: SyncState.State,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.post("syncLogout", GlobalPaths.syncLogout, {
        success: SyncState.State,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.get("syncDiscover", GlobalPaths.syncSpaces, {
        success: SyncDiscovery,
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncCreate", GlobalPaths.syncSpaces, {
        payload: SyncSetup.CreateInput,
        success: SyncCreateResult,
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncJoin", GlobalPaths.syncSpaceJoin, {
        payload: SyncSetup.JoinInput,
        success: SyncState.State,
        error: SyncSetupApiError,
      }),
      HttpApiEndpoint.post("syncActivate", GlobalPaths.syncSpaceActivate, {
        payload: SyncControl.SwitchInput,
        success: SyncControl.SwitchResult,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.post("syncLeave", GlobalPaths.syncSpaceLeave, {
        payload: SyncNamespaceInput,
        success: Schema.Array(Schema.NonEmptyString),
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.patch("syncEnabled", GlobalPaths.syncEnabled, {
        payload: SyncEnabledInput,
        success: SyncState.State,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.patch("syncInterval", GlobalPaths.syncInterval, {
        payload: SyncIntervalInput,
        success: SyncState.State,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.delete("syncDelete", GlobalPaths.syncSpaceDelete, {
        params: SyncNamespaceInput,
        success: Schema.Array(Schema.NonEmptyString),
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.delete("syncRemove", GlobalPaths.syncRemove, {
        success: Schema.Array(Schema.NonEmptyString),
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.get("syncUnassigned", GlobalPaths.syncUnassigned, {
        success: Schema.Array(Schema.NonEmptyString),
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.post("syncAssignUnassigned", GlobalPaths.syncUnassigned, {
        payload: SyncControl.AssignInput,
        success: Schema.Array(Schema.NonEmptyString),
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.get("syncStatus", GlobalPaths.syncStatus, {
        success: SyncControl.Status,
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.post("syncNow", GlobalPaths.syncNow, {
        success: Schema.Boolean,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.get("syncCloudStatus", GlobalPaths.syncCloud, {
        success: SyncRoot.Inspection,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.post("syncCloudInitialize", GlobalPaths.syncCloud, {
        success: Schema.Array(Schema.NonEmptyString),
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.post("syncCloudJoin", GlobalPaths.syncCloudJoin, {
        success: Schema.Array(Schema.NonEmptyString),
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.delete("syncCloudClear", GlobalPaths.syncCloud, {
        success: Schema.Boolean,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.get("syncSessions", GlobalPaths.syncSessions, {
        success: Schema.Array(SyncMetadata.Item),
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.post("syncHydrate", GlobalPaths.syncHydrate, {
        payload: SyncControl.HydrateInput,
        success: SyncControl.HydrateResult,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.post("syncSessionDelete", GlobalPaths.syncSessionDelete, {
        payload: SyncControl.DeleteSessionInput,
        success: Schema.Boolean,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.get("syncDevices", GlobalPaths.syncDevices, {
        success: SyncDevice.State,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.patch("syncDeviceUpdate", GlobalPaths.syncDevices, {
        payload: SyncControl.DeviceUpdate,
        success: SyncDevice.State,
        error: SyncControlApiError,
      }),
      HttpApiEndpoint.get("syncRecoveryExport", GlobalPaths.syncRecovery, {
        success: SyncControl.Recovery,
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.patch("configUpdate", GlobalPaths.config, {
        payload: ConfigV1.Info,
        success: described(ConfigV1.Info, "Successfully updated global config"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.config.update",
          summary: "Update global configuration",
          description: "Update global OpenCode configuration settings and preferences.",
        }),
      ),
      HttpApiEndpoint.post("dispose", GlobalPaths.dispose, {
        success: described(Schema.Boolean, "Global disposed"),
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.dispose",
          summary: "Dispose instance",
          description: "Clean up and dispose all OpenCode instances, releasing all resources.",
        }),
      ),
      HttpApiEndpoint.post("upgrade", GlobalPaths.upgrade, {
        payload: GlobalUpgradeInput,
        success: described(GlobalUpgradeResult, "Upgrade result"),
        error: HttpApiError.BadRequest,
      }).annotateMerge(
        OpenApi.annotations({
          identifier: "global.upgrade",
          summary: "Upgrade opencode",
          description: "Upgrade opencode to the specified version.",
        }),
      ),
    )
    .annotateMerge(OpenApi.annotations({ title: "global", description: "Global server routes." })),
)
