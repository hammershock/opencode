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

export const GlobalPaths = {
  health: "/global/health",
  event: "/global/event",
  config: "/global/config",
  dispose: "/global/dispose",
  upgrade: "/global/upgrade",
  syncSetup: "/global/sync/setup",
  syncAuthorize: "/global/sync/setup/authorize",
  syncComplete: "/global/sync/setup/complete",
  syncReuseLegacy: "/global/sync/setup/reuse-legacy",
  syncEnabled: "/global/sync/enabled",
  syncStatus: "/global/sync/status",
  syncNow: "/global/sync/now",
  syncDevices: "/global/sync/devices",
  syncBindings: "/global/sync/bindings",
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
      HttpApiEndpoint.get("syncSetup", GlobalPaths.syncSetup, {
        success: Schema.Struct({ config: Schema.optional(SyncSetup.Config), legacy: SyncSetup.Legacy }),
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.post("syncAuthorize", GlobalPaths.syncAuthorize, {
        payload: SyncSetup.BeginInput,
        success: SyncSetup.BeginResult,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.post("syncComplete", GlobalPaths.syncComplete, {
        payload: SyncSetup.CompleteInput,
        success: SyncSetup.SetupResult,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.post("syncReuseLegacy", GlobalPaths.syncReuseLegacy, {
        payload: SyncSetup.ReuseLegacyInput,
        success: SyncSetup.SetupResult,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.patch("syncEnabled", GlobalPaths.syncEnabled, {
        payload: SyncSetup.EnabledInput,
        success: SyncSetup.Config,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.get("syncStatus", GlobalPaths.syncStatus, {
        success: SyncControl.Status,
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.post("syncNow", GlobalPaths.syncNow, {
        success: Schema.Boolean,
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.get("syncDevices", GlobalPaths.syncDevices, {
        success: SyncDevice.State,
        error: HttpApiError.ServiceUnavailable,
      }),
      HttpApiEndpoint.patch("syncDeviceUpdate", GlobalPaths.syncDevices, {
        payload: SyncControl.DeviceUpdate,
        success: SyncDevice.State,
        error: HttpApiError.BadRequest,
      }),
      HttpApiEndpoint.patch("syncBindingUpdate", GlobalPaths.syncBindings, {
        payload: SyncControl.BindingUpdate,
        success: SyncDevice.State,
        error: HttpApiError.BadRequest,
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
