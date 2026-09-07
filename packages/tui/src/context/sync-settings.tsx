import { createSignal, onCleanup, onMount } from "solid-js"
import type { GlobalSyncDiscoverResponse, GlobalSyncStateResponse } from "@opencode-ai/sdk/v2"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { BaiduAuth } from "@opencode-ai/core/sync/baidu-auth"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { SyncSpace as SyncSpaceProtocol } from "@opencode-ai/core/sync/space"
import { hostname } from "node:os"
import openBrowser from "open"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useKV } from "./kv"
import { useClipboard } from "./clipboard"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { remoteFailureDetail, useRemoteStatus } from "./remote-status"
import { syncTransferSummary } from "../component/sync-transfer-summary"
import {
  showAssignUnassignedSessions,
  showSyncDevices,
  showSyncSettings,
  syncStatus,
  type SyncSettingsActions,
  type SyncSettingsViewModel,
  type SyncSpace,
} from "../component/dialog-sync-settings"

const DISMISSED_UNASSIGNED = "sync_unassigned_dismissed"

type OpenView = "overview" | "devices"

const initial: SyncSettingsViewModel = {
  account: { state: "disconnected", oauth: { state: "idle" } },
  enabled: false,
  interval: 30,
  state: "off",
  remote: "idle",
  spaces: [],
  devices: [],
  bindings: [],
  pending: 0,
  unassigned: [],
}

export const SYNC_REMOTE_REFRESH_TIMEOUT = 8_000

export async function withSyncRefreshTimeout<A>(
  run: (signal: AbortSignal) => Promise<A>,
  timeout = SYNC_REMOTE_REFRESH_TIMEOUT,
) {
  const controller = new AbortController()
  let timer: Timer | undefined
  try {
    return await Promise.race([
      run(controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error("Sync refresh timed out"))
        }, timeout)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

export function unassignedFingerprint(spaceID: string, sessionIDs: readonly string[]) {
  return `${spaceID}\n${sessionIDs.slice().sort().join("\n")}`
}

const MISSING_APP_MESSAGE = BaiduAuth.MISSING_APP_MESSAGE
const INCOMPATIBLE_LOCAL_STATE_MESSAGE = SyncSetup.INCOMPATIBLE_LOCAL_STATE_MESSAGE

export function syncOperationFailure(error: unknown) {
  if (hasMissingApp(error, 0)) return MISSING_APP_MESSAGE
  if (hasSetupKind(error, "incompatible-local-state", 0)) return INCOMPATIBLE_LOCAL_STATE_MESSAGE
  if (hasSetupKind(error, "unconfigured", 0)) return "Select a sync space first"
  if (hasSetupKind(error, "locked", 0)) return "Import the recovery key for the active space"
  const stage = syncFailureStage(error, 0)
  if (stage) return `Sync failed during ${stage} · ${remoteFailureDetail(error)}`
  const detail = remoteFailureDetail(error)
  if (detail !== "remote operation failed") return `Sync failed · ${detail}`
  return "Sync operation failed"
}

const SYNC_FAILURE_STAGES = new Set(["attachment", "segment", "head", "pull", "hydrate", "collect", "delete"])

function syncFailureStage(value: unknown, depth: number): string | undefined {
  if (depth > 4 || !value || typeof value !== "object") return
  const record = value as Record<string, unknown>
  if (typeof record.stage === "string" && SYNC_FAILURE_STAGES.has(record.stage)) return record.stage
  for (const item of [record.data, record.error, record.cause, record.body, record.diagnostic]) {
    const stage = syncFailureStage(item, depth + 1)
    if (stage) return stage
  }
}

function hasSetupKind(value: unknown, kind: string, depth: number): boolean {
  if (depth > 4 || !value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (record.kind === kind || record.code === kind) return true
  return [record.data, record.error, record.cause, record.body].some((item) => hasSetupKind(item, kind, depth + 1))
}

function hasMissingApp(value: unknown, depth: number): boolean {
  if (depth > 4) return false
  if (typeof value === "string") return value === "missing-app" || value.includes(MISSING_APP_MESSAGE)
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return [record.kind, record.code, record.message, record.data, record.error, record.cause, record.body].some((item) =>
    hasMissingApp(item, depth + 1),
  )
}

export function createLoopbackCallback(timeout = 120_000) {
  type Callback = {
    callbackURL: string
    respond: (result: { status: "success" } | { status: "error"; detail: string }) => void
  }
  let finish: (value: Callback | undefined) => void = () => undefined
  let settled = false
  const callback = new Promise<Callback | undefined>((resolve) => {
    finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
  })
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url)
      if (request.method !== "GET" || url.pathname !== "/callback") return new Response("Not found", { status: 404 })
      return new Promise<Response>((resolve) => {
        finish({
          callbackURL: request.url,
          respond: (result) =>
            resolve(
              new Response(
                result.status === "success"
                  ? OauthCallbackPage.success({ provider: "Baidu Netdisk" })
                  : OauthCallbackPage.error(result.detail, { provider: "Baidu Netdisk" }),
                { status: result.status === "success" ? 200 : 400, headers: { "Content-Type": "text/html" } },
              ),
            ),
        })
      })
    },
  })
  const timer = setTimeout(() => finish(undefined), timeout)
  return {
    redirectURI: `http://127.0.0.1:${server.port}/callback`,
    callback,
    close() {
      clearTimeout(timer)
      finish(undefined)
      server.stop(true)
    },
  }
}

export const { use: useSyncSettings, provider: SyncSettingsProvider } = createSimpleContext({
  name: "SyncSettings",
  init: () => {
    const sdk = useSDK()
    const kv = useKV()
    const clipboard = useClipboard()
    const dialog = useDialog()
    const toast = useToast()
    const remoteStatus = useRemoteStatus()
    const [model, setModel] = createSignal(initial)
    let discovered: GlobalSyncDiscoverResponse["spaces"] = []
    let oauth:
      | {
          attemptID: string
          mode: "connect" | "switch"
          completion: "loopback" | "manual"
        }
      | undefined
    let loopback: ReturnType<typeof createLoopbackCallback> | undefined
    let bindingRevision = ""
    let remoteGeneration = 0
    let remoteAbort: AbortController | undefined

    const unsubscribe = sdk.event.on("event", (event) => {
      if (event.payload.type === "server.connected") {
        remoteStatus.clear("sync-transfer")
        return
      }
      if (event.payload.type !== "sync.transfer.updated") return
      const progress = event.payload.properties.progress
      if (progress.state === "idle") {
        remoteStatus.clear("sync-transfer")
        return
      }
      remoteStatus.set("sync-transfer", {
        area: "Sync",
        operation: "synchronize",
        phase: syncTransferSummary(progress).replace(/^◐ /, ""),
        state: "running",
      })
    })

    onCleanup(() => {
      loopback?.close()
      unsubscribe()
      remoteAbort?.abort()
    })

    type LocalState = GlobalSyncStateResponse | null | undefined

    const applyLocal = (state: LocalState) => {
      if (!state) {
        setModel((current) => ({
          ...initial,
          account: current.account.state === "disconnected" ? current.account : initial.account,
          remote: "idle",
        }))
        return
      }
      const previous = new Map(model().spaces.map((space) => [space.id, space]))
      const local = state.spaces.map((item): SyncSpace => {
        const cached = previous.get(item.descriptor.namespaceID)
        const active = state.activeSpaceID === item.descriptor.namespaceID
        return {
          id: item.descriptor.namespaceID,
          name: item.descriptor.name,
          supported: SyncSpaceProtocol.compatible(item.descriptor.protocol),
          protocol: `${item.descriptor.protocol.major}.${item.descriptor.protocol.minor}`,
          encryption: item.descriptor.encryption === "none" ? "off" : "encrypted",
          updatedAt: new Date(item.descriptor.updatedAt).toLocaleString(),
          devices: cached?.devices ?? item.descriptor.summary.devices,
          sessions: cached?.sessions ?? item.descriptor.summary.sessions,
          membership: active ? "active" : "joined",
          state: state.enabled ? "idle" : "off",
        }
      })
      const localIDs = new Set(local.map((space) => space.id))
      const spaces = [
        ...local,
        ...discovered
          .filter((item) => !localIDs.has(item.descriptor.namespaceID))
          .map(
            (item) =>
              previous.get(item.descriptor.namespaceID) ??
              ({
                id: item.descriptor.namespaceID,
                name: item.descriptor.name,
                supported: item.status === "compatible",
                protocol: `${item.descriptor.protocol.major}.${item.descriptor.protocol.minor}`,
                encryption: item.descriptor.encryption === "none" ? "off" : "encrypted",
                updatedAt: new Date(item.descriptor.updatedAt).toLocaleString(),
                membership: "available",
                state: state.enabled ? "idle" : "off",
                detail: item.status === "unsupported" ? "Unsupported protocol" : undefined,
              } satisfies SyncSpace),
          ),
      ]
      setModel((current) => ({
        ...current,
        account: state.account
          ? { state: "connected", maskedAccount: state.account.maskedDisplay }
          : current.account.state === "disconnected"
            ? current.account
            : initial.account,
        enabled: state.enabled,
        interval: state.intervalSeconds,
        state: state.enabled ? "idle" : "off",
        activeSpace: spaces.find((space) => space.id === state.activeSpaceID),
        spaces,
      }))
    }

    const refreshLocal = async (notify = false) => {
      const result = await sdk.client.global.syncState({ throwOnError: true }).then(
        (value) => ({ state: value.data as LocalState, error: undefined }),
        (error) => ({ state: undefined, error }),
      )
      if (result.error) {
        const detail = syncOperationFailure(result.error)
        setModel((current) => ({ ...current, state: "attention", remote: "unavailable", detail }))
        if (notify) toast.show({ message: detail, variant: "warning" })
        return undefined
      }
      applyLocal(result.state)
      return result.state
    }

    const refresh = async (discover = false, notify = false) => {
      const state = await refreshLocal(notify)
      if (!state?.account) return
      remoteAbort?.abort()
      const controller = new AbortController()
      remoteAbort = controller
      const generation = ++remoteGeneration
      setModel((current) => ({ ...current, remote: "checking", detail: undefined }))

      const current = withSyncRefreshTimeout(async (timeoutSignal) => {
        const signal = AbortSignal.any([controller.signal, timeoutSignal])
        const status = await sdk.client.global.syncStatus({ throwOnError: true, signal }).then(
          (result) => result.data,
          () => undefined,
        )
        const authenticated = Boolean(status?.authenticated)
        let attention = status === undefined
        const [discovery, activeSessions, deviceResult, bindingResult, unassigned] = await Promise.all([
          discover && authenticated
            ? sdk.client.global.syncDiscover({ throwOnError: true, signal }).then(
                (value) => value.data,
                () => {
                  attention = true
                  return undefined
                },
              )
            : undefined,
          state.activeSpaceID
            ? sdk.client.global.syncSessions({ throwOnError: true, signal }).then(
                (result) => result.data,
                () => {
                  attention = true
                  return []
                },
              )
            : [],
          state.activeSpaceID
            ? sdk.client.global.syncDevices({ throwOnError: true, signal }).then(
                (result) => result.data,
                () => {
                  attention = true
                  return undefined
                },
              )
            : undefined,
          authenticated
            ? sdk.client.v2.targetBinding.list({ throwOnError: true, signal }).then(
                (result) => result.data,
                () => {
                  attention = true
                  return undefined
                },
              )
            : undefined,
          authenticated
            ? sdk.client.global.syncUnassigned({ throwOnError: true, signal }).then(
                (result) => result.data,
                () => {
                  attention = true
                  return []
                },
              )
            : [],
        ])
        if (generation !== remoteGeneration) return
        if (discovery) discovered = discovery.spaces
        if (bindingResult) bindingRevision = bindingResult.revision
        const local = new Map(state.spaces.map((item) => [item.descriptor.namespaceID, item]))
        const catalog = new Map(discovered.map((item) => [item.descriptor.namespaceID, item]))
        state.spaces.forEach((item) => {
          if (!catalog.has(item.descriptor.namespaceID))
            catalog.set(item.descriptor.namespaceID, { status: "compatible", descriptor: item.descriptor })
        })
        const spaces = Array.from(catalog.values()).map((item): SyncSpace => {
          const binding = local.get(item.descriptor.namespaceID)
          const active = state.activeSpaceID === item.descriptor.namespaceID
          return {
            id: item.descriptor.namespaceID,
            name: item.descriptor.name,
            supported: item.status === "compatible",
            protocol: `${item.descriptor.protocol.major}.${item.descriptor.protocol.minor}`,
            encryption: item.descriptor.encryption === "none" ? "off" : "encrypted",
            updatedAt: new Date(item.descriptor.updatedAt).toLocaleString(),
            devices: active ? deviceResult?.devices.length : undefined,
            sessions: active ? activeSessions.length : undefined,
            membership: active ? "active" : binding ? "joined" : "available",
            state: active
              ? status?.locked
                ? "locked"
                : status?.error
                  ? "attention"
                  : "idle"
              : state.enabled
                ? "idle"
                : "off",
            detail: item.status === "unsupported" ? "Unsupported protocol" : undefined,
          }
        })
        const bindingSessions = activeSessions.reduce((result, session) => {
          if (!session.targetLabel) return result
          const current = result.get(session.targetLabel) ?? []
          result.set(session.targetLabel, [...current, session.sessionID])
          return result
        }, new Map<string, string[]>())
        Object.keys(bindingResult?.bindings ?? {}).forEach((label) => {
          if (!bindingSessions.has(label)) bindingSessions.set(label, [])
        })
        const stateName = status?.locked
          ? "locked"
          : status?.error || attention
            ? "attention"
            : state.enabled
              ? "idle"
              : "off"
        if (status?.diagnostic)
          remoteStatus.set("sync-runtime-error", {
            area: "Sync",
            operation: "background synchronization",
            phase: status.diagnostic.stage,
            state: "failed",
            detail: remoteFailureDetail(status.diagnostic),
          })
        else remoteStatus.clear("sync-runtime-error")
        setModel({
          account:
            status && !authenticated
              ? initial.account
              : state.account
                ? { state: "connected", maskedAccount: state.account.maskedDisplay }
                : model().account.state === "disconnected"
                  ? model().account
                  : initial.account,
          enabled: state.enabled,
          interval: state.intervalSeconds,
          state: stateName,
          remote: attention ? "unavailable" : "ready",
          detail: status?.error ?? (attention ? "Some sync information is unavailable" : undefined),
          activeSpace: spaces.find((item) => item.id === state.activeSpaceID),
          spaces,
          devices:
            deviceResult?.devices.map((device) => ({
              id: device.id,
              name: device.name,
              current: device.id === state.deviceID,
              state: device.revoked ? "revoked" : "ready",
            })) ?? [],
          bindings: Array.from(bindingSessions).map(([label, sessionIDs]) => ({
            label,
            targetID: bindingResult?.bindings[label],
            sessionIDs,
          })),
          pending: status?.outbox ?? 0,
          unassigned,
        })
        if (attention && notify) toast.show({ message: "Some sync information is unavailable", variant: "warning" })
      })
        .catch(() => {
          if (generation !== remoteGeneration) return
          const detail = "Sync status is unavailable"
          setModel((current) => ({ ...current, state: "attention", remote: "unavailable", detail }))
          if (notify) toast.show({ message: detail, variant: "warning" })
        })
        .finally(() => {
          if (generation === remoteGeneration) {
            remoteAbort = undefined
          }
        })
      return current
    }

    const completeOAuth = async (
      response: { type: "loopback"; callbackURL: string } | { type: "manual"; code: string },
    ) => {
      if (!oauth) throw new Error("OAuth attempt is missing")
      const input = { attemptID: oauth.attemptID, response }
      if (oauth.mode === "switch") await sdk.client.global.syncOAuthSwitchAccount(input, { throwOnError: true })
      else await sdk.client.global.syncOAuthComplete(input, { throwOnError: true })
      oauth = undefined
      await refresh(true)
    }

    const beginManual = async () => {
      loopback?.close()
      loopback = undefined
      const mode = oauth?.mode ?? "connect"
      const result = await sdk.client.global.syncOAuthBegin(
        { redirectURI: "oob", completion: "manual" },
        { throwOnError: true },
      )
      oauth = { attemptID: result.data.attemptID, mode, completion: "manual" }
      setModel((current) => ({
        ...current,
        account: {
          state: "disconnected",
          oauth: { state: "manual", authorizationURL: result.data.authorizationURL },
        },
      }))
      await openBrowser(result.data.authorizationURL).catch(() => undefined)
      showSyncSettings(dialog, model, actions)
    }

    const beginOAuth = async (mode: "connect" | "switch" = "connect") => {
      await sdk.client.global.syncInitialize({ deviceName: hostname() }, { throwOnError: true })
      loopback?.close()
      loopback = createLoopbackCallback()
      const result = await sdk.client.global.syncOAuthBegin(
        { redirectURI: loopback.redirectURI, completion: "loopback" },
        { throwOnError: true },
      )
      oauth = { attemptID: result.data.attemptID, mode, completion: "loopback" }
      setModel((current) => ({
        ...current,
        account: {
          state: "disconnected",
          oauth: { state: "waiting", authorizationURL: result.data.authorizationURL },
        },
      }))
      showSyncSettings(dialog, model, actions)
      const opened = await openBrowser(result.data.authorizationURL).then(
        () => true,
        () => false,
      )
      if (!opened) {
        if (oauth?.attemptID !== result.data.attemptID) return
        return beginManual()
      }
      const callback = await loopback.callback
      if (!callback) {
        if (oauth?.attemptID !== result.data.attemptID) return
        return beginManual()
      }
      try {
        await completeOAuth({ type: "loopback", callbackURL: callback.callbackURL })
        callback.respond({ status: "success" })
        setTimeout(() => {
          loopback?.close()
          loopback = undefined
        }, 1_000)
      } catch {
        callback.respond({ status: "error", detail: "Authorization could not be completed. Return to OpenCode." })
        setTimeout(() => {
          loopback?.close()
          loopback = undefined
        }, 1_000)
        throw new Error("Baidu Netdisk authorization failed")
      }
      showSyncSettings(dialog, model, actions)
    }

    const assignPrompt = async (force: boolean) => {
      const ids = model().unassigned.slice().sort()
      if (!model().activeSpace || ids.length === 0) return
      const fingerprint = unassignedFingerprint(model().activeSpace!.id, ids)
      if (!force && kv.get(DISMISSED_UNASSIGNED, "") === fingerprint) return
      await showAssignUnassignedSessions(dialog, {
        sessionIDs: ids,
        decide: async (assign, sessionIDs) => {
          if (assign) await actions.assignUnassigned(sessionIDs)
          else kv.set(DISMISSED_UNASSIGNED, fingerprint)
        },
      })
    }

    const mutate = async (effect: () => Promise<unknown>, discover = false) => {
      await effect()
      await refresh(discover, true)
    }
    const mutateLocal = async (effect: () => Promise<unknown>) => {
      await effect()
      await refreshLocal(true)
    }

    const actions: SyncSettingsActions = {
      connect: beginOAuth,
      useManualOAuth: beginManual,
      copy: async (value) => {
        await clipboard.write?.(value)
      },
      submitOAuthCode: async (code) => {
        if (oauth?.completion !== "manual") throw new Error("Manual OAuth is not active")
        await completeOAuth({ type: "manual", code })
      },
      syncNow: async () => {
        if (!model().activeSpace) {
          await refresh(true)
          if (!model().activeSpace) return
        }
        setModel((current) => ({ ...current, state: "syncing" }))
        await mutate(() => sdk.client.global.syncNow({ throwOnError: true }))
      },
      setEnabled: (enabled) => mutateLocal(() => sdk.client.global.syncEnabled({ enabled }, { throwOnError: true })),
      setInterval: (intervalSeconds) =>
        mutateLocal(() => sdk.client.global.syncInterval({ intervalSeconds }, { throwOnError: true })),
      discoverSpaces: () => refresh(true),
      createSpace: async (input) => {
        const result = await sdk.client.global.syncCreate(
          { name: input.name, encryption: input.encryption === "off" ? "none" : "aes-256-gcm" },
          { throwOnError: true },
        )
        const activation = await sdk.client.global.syncActivate(
          { namespaceID: result.data.descriptor.namespaceID },
          { throwOnError: true },
        )
        await refresh(true)
        return {
          recoveryKey: result.data.recoveryString,
          spaceID: result.data.descriptor.namespaceID,
          activation: activation.data.status,
        }
      },
      prepareEnter: async (input) => {
        const space = model().spaces.find((item) => item.id === input.spaceID)
        return {
          localOnly: model().unassigned.length,
          cloudOnly: space?.sessions,
        }
      },
      enterSpace: async (input) => {
        await sdk.client.global.syncJoin(
          { namespaceID: input.spaceID, ...(input.recoveryKey ? { recoveryString: input.recoveryKey } : {}) },
          { throwOnError: true },
        )
        const activation = await sdk.client.global.syncActivate({ namespaceID: input.spaceID }, { throwOnError: true })
        await refresh(true)
        return { status: activation.data.status }
      },
      switchSpace: async (input) => {
        const result = await sdk.client.global.syncActivate(
          { namespaceID: input.spaceID, force: input.force },
          { throwOnError: true },
        )
        await refresh(true)
        if (result.data.status === "switched") await assignPrompt(false)
        return { status: result.data.status }
      },
      leaveSpace: (namespaceID) =>
        mutate(() => sdk.client.global.syncLeave({ namespaceID }, { throwOnError: true }), true),
      deleteSpace: (namespaceID) =>
        mutate(() => sdk.client.global.syncDelete({ namespaceID }, { throwOnError: true }), true),
      logout: () => mutate(() => sdk.client.global.syncLogout({ throwOnError: true }), true),
      removeFromDevice: () => mutate(() => sdk.client.global.syncRemove({ throwOnError: true }), true),
      revokeDevice: (id) =>
        mutate(() => sdk.client.global.syncDeviceUpdate({ id, revoke: true }, { throwOnError: true }), true),
      exportRecoveryKey: () =>
        sdk.client.global.syncRecoveryExport({ throwOnError: true }).then((result) => result.data.recoveryString),
      renameDevice: (id, name) =>
        mutate(() => sdk.client.global.syncDeviceUpdate({ id, name }, { throwOnError: true }), true),
      updateBinding: (portableTargetLabel, targetID, expectedSessionIDs) =>
        mutate(
          () =>
            sdk.client.v2.targetBinding.bind(
              {
                portableTargetLabel,
                targetID,
                expectedRevision: bindingRevision,
                expectedSessionIDs: [...expectedSessionIDs],
              },
              { throwOnError: true },
            ),
          true,
        ),
      removeBinding: (portableTargetLabel, expectedSessionIDs) =>
        mutate(
          () =>
            sdk.client.v2.targetBinding.unbind(
              {
                portableTargetLabel,
                expectedRevision: bindingRevision,
                expectedSessionIDs: [...expectedSessionIDs],
              },
              { throwOnError: true },
            ),
          true,
        ),
      targets: () =>
        sdk.client.v2.target.list({ throwOnError: true }).then((result) =>
          result.data.targets.map((target) => ({
            id: target.id,
            name: target.name,
            description: target.connection.host,
          })),
        ),
      assignUnassigned: async (sessionIDs) => {
        await sdk.client.global.syncAssignUnassigned({ sessionIDs: [...sessionIDs] }, { throwOnError: true })
        kv.set(DISMISSED_UNASSIGNED, "")
        await refresh()
      },
      promptUnassigned: assignPrompt,
      onError: (error) => {
        const message = syncOperationFailure(error)
        setModel((current) => ({ ...current, state: "attention", detail: message }))
        toast.show({ message, variant: "error" })
        void refresh(true)
      },
    }

    const render = (view: OpenView) => {
      if (view === "devices") return showSyncDevices(dialog, model, actions)
      showSyncSettings(dialog, model, actions)
    }

    onMount(() => void refreshLocal())

    return {
      model,
      status: () => syncStatus(model().state),
      async open(view: OpenView = "overview") {
        render(view)
        if (view === "devices") void refresh(true, true)
        else void refreshLocal(true)
        return "completed" as const
      },
      refresh,
    }
  },
})
