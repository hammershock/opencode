import { createSignal, onCleanup, onMount } from "solid-js"
import type { GlobalSyncStateResponse } from "@opencode-ai/sdk/v2"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { BaiduAuth } from "@opencode-ai/core/sync/baidu-auth"
import { SyncSetup } from "@opencode-ai/core/sync/setup"
import { SyncRoot } from "@opencode-ai/core/sync/root"
import { hostname } from "node:os"
import openBrowser from "open"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useClipboard } from "./clipboard"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
import { remoteFailureDetail, useRemoteStatus } from "./remote-status"
import { syncTransferSummary } from "../component/sync-transfer-summary"
import {
  confirmInitializeCloud,
  confirmJoinCloud,
  promptBaiduApplication,
  showPostLoginSyncChoice,
  showSyncDevices,
  showSyncSettings,
  syncStatus,
  type SyncSettingsActions,
  type SyncSettingsViewModel,
} from "../component/dialog-sync-settings"

type OpenView = "overview" | "devices"

const initial: SyncSettingsViewModel = {
  account: { state: "disconnected", oauth: { state: "idle" } },
  enabled: false,
  interval: 30,
  state: "off",
  cloud: "unknown",
  devices: [],
  bindings: [],
  pending: 0,
}

type LocalState = GlobalSyncStateResponse | null | undefined

export function syncLocalPresentation(current: SyncSettingsViewModel, state: LocalState) {
  if (!state)
    return {
      configured: false,
      model: {
        ...initial,
        account: current.account.state === "disconnected" ? current.account : initial.account,
      },
    }
  const configured = Boolean(state.activeSpaceID && SyncRoot.isAccountScope(state.activeSpaceID))
  const authenticated = Boolean(state.account)
  return {
    configured,
    model: {
      ...current,
      account: state.account
        ? { state: "connected" as const, maskedAccount: state.account.maskedDisplay }
        : current.account.state === "disconnected"
          ? current.account
          : initial.account,
      enabled: authenticated && configured && state.enabled,
      interval: state.intervalSeconds,
      state: authenticated && configured && state.enabled ? ("idle" as const) : ("off" as const),
    },
  }
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

const MISSING_APP_MESSAGE = BaiduAuth.MISSING_APP_MESSAGE
const INCOMPATIBLE_LOCAL_STATE_MESSAGE = SyncSetup.INCOMPATIBLE_LOCAL_STATE_MESSAGE

export function syncOperationFailure(error: unknown) {
  if (hasMissingApp(error, 0)) return MISSING_APP_MESSAGE
  if (hasSetupKind(error, "incompatible-local-state", 0)) return INCOMPATIBLE_LOCAL_STATE_MESSAGE
  if (hasSetupKind(error, "remote-uninitialized", 0)) return "Cloud sync is not initialized"
  if (hasSetupKind(error, "incompatible-remote", 0)) return "Cloud sync protocol is incompatible"
  if (hasSetupKind(error, "unconfigured", 0)) return "Cloud sync is not initialized"
  const stage = syncFailureStage(error, 0)
  if (stage) return `Sync failed during ${stage} · ${remoteFailureDetail(error)}`
  return "Sync operation failed"
}

const SYNC_FAILURE_STAGES = new Set([
  "attachment",
  "segment",
  "head",
  "pull",
  "hydrate",
  "collect",
  "catalog",
  "delete",
])

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
    const clipboard = useClipboard()
    const dialog = useDialog()
    const toast = useToast()
    const remoteStatus = useRemoteStatus()
    const [model, setModel] = createSignal(initial)
    let oauth:
      | {
          attemptID: string
          mode: "connect" | "switch"
          completion: "loopback" | "manual"
        }
      | undefined
    let loopback: ReturnType<typeof createLoopbackCallback> | undefined
    let bindingRevision = ""
    let localConfigured = false
    let remoteGeneration = 0
    let remoteAbort: AbortController | undefined
    let initializationPrompt = false
    let onInitializationRequired = () => Promise.resolve()

    const unsubscribe = sdk.event.on("event", (event) => {
      if (event.payload.type === "server.connected") {
        remoteStatus.clear("sync-transfer")
        return
      }
      if (event.payload.type === "sync.initialization.required") {
        void onInitializationRequired()
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

    const applyLocal = (state: LocalState) => {
      const presentation = syncLocalPresentation(model(), state)
      localConfigured = presentation.configured
      setModel(presentation.model)
    }

    const refreshLocal = async (notify = false) => {
      const result = await sdk.client.global.syncState({ throwOnError: true }).then(
        (value) => ({ state: value.data as LocalState, error: undefined }),
        (error) => ({ state: undefined, error }),
      )
      if (result.error) {
        const detail = syncOperationFailure(result.error)
        setModel((current) => ({ ...current, state: "attention", detail }))
        if (notify) toast.show({ message: detail, variant: "warning" })
        return undefined
      }
      applyLocal(result.state)
      return result.state
    }

    const checkCloud = async (notify = false, details = true) => {
      const state = await refreshLocal(notify)
      if (!state?.account) return
      remoteAbort?.abort()
      const controller = new AbortController()
      remoteAbort = controller
      const generation = ++remoteGeneration
      setModel((current) => ({ ...current, cloud: "checking", detail: undefined }))
      return withSyncRefreshTimeout(async (timeoutSignal) => {
        const signal = AbortSignal.any([controller.signal, timeoutSignal])
        const cloud = await sdk.client.global.syncCloudStatus({ throwOnError: true, signal }).then(
          (result) => result.data,
          (error) => {
            throw error
          },
        )
        if (generation !== remoteGeneration) return
        if (cloud.status !== "ready") {
          // The checked-in SDK can lag the source HTTP schema during protocol
          // development; the generated client is refreshed before release.
          const status: string = cloud.status
          const presentation =
            status === "legacy-upgrade-required"
              ? {
                  cloud: "upgrade-required" as const,
                  detail: "Legacy cloud data must be cleared or explicitly migrated before sync can continue",
                }
              : status === "replaced"
                ? {
                    cloud: "replaced" as const,
                    detail: "Cloud sync data was reset or replaced on another device",
                  }
                : status === "unavailable"
                  ? {
                      cloud: "unavailable" as const,
                      detail: "Cloud control is temporarily unavailable; no data was changed",
                    }
                  : status === "incompatible"
                    ? { cloud: "incompatible" as const, detail: "Cloud sync protocol is incompatible" }
                    : { cloud: "uninitialized" as const, detail: undefined }
          setModel((current) => ({ ...current, ...presentation, devices: [], bindings: [] }))
          return
        }
        if (!localConfigured) {
          setModel((current) => ({ ...current, cloud: "ready", devices: [], bindings: [] }))
          return
        }
        if (!details) {
          setModel((current) => ({ ...current, cloud: "ready" }))
          return
        }
        const [status, deviceResult, activeSessions, bindingResult] = await Promise.all([
          sdk.client.global.syncStatus({ throwOnError: true, signal }).then((result) => result.data),
          sdk.client.global.syncDevices({ throwOnError: true, signal }).then((result) => result.data),
          sdk.client.global.syncSessions({ throwOnError: true, signal }).then((result) => result.data),
          sdk.client.v2.targetBinding.list({ throwOnError: true, signal }).then((result) => result.data),
        ])
        if (generation !== remoteGeneration) return
        bindingRevision = bindingResult.revision
        const bindingSessions = activeSessions.reduce((result, session) => {
          if (!session.targetLabel) return result
          const current = result.get(session.targetLabel) ?? []
          result.set(session.targetLabel, [...current, session.sessionID])
          return result
        }, new Map<string, string[]>())
        Object.keys(bindingResult.bindings).forEach((label) => {
          if (!bindingSessions.has(label)) bindingSessions.set(label, [])
        })
        if (status.diagnostic)
          remoteStatus.set("sync-runtime-error", {
            area: "Sync",
            operation: "background synchronization",
            phase: status.diagnostic.stage,
            state: "failed",
            detail: remoteFailureDetail(status.diagnostic),
          })
        else remoteStatus.clear("sync-runtime-error")
        setModel((current) => ({
          ...current,
          cloud: "ready",
          state: status.error ? "attention" : current.enabled ? "idle" : "off",
          detail: status.error,
          pending: status.outbox,
          devices: deviceResult.devices.map((device) => ({
            id: device.id,
            name: device.name,
            current: device.id === state.deviceID,
            state: device.revoked ? "revoked" : "ready",
          })),
          bindings: Array.from(bindingSessions).map(([label, sessionIDs]) => ({
            label,
            targetID: bindingResult.bindings[label],
            sessionIDs,
          })),
        }))
      })
        .catch((error) => {
          if (generation !== remoteGeneration) return
          const detail = syncOperationFailure(error)
          setModel((current) => ({ ...current, cloud: "unavailable", state: "attention", detail }))
          if (notify) toast.show({ message: detail, variant: "warning" })
        })
        .finally(() => {
          if (generation === remoteGeneration) remoteAbort = undefined
        })
    }

    const ensureCloud = async (automatic: boolean) => {
      await checkCloud(true, false)
      if (model().cloud === "ready") {
        if (!localConfigured) {
          const confirmed = await confirmJoinCloud(dialog)
          if (!confirmed) {
            if (automatic) await sdk.client.global.syncEnabled({ enabled: false }, { throwOnError: true })
            await refreshLocal()
            return false
          }
          await sdk.client.global.syncCloudJoin({ throwOnError: true })
          await refreshLocal()
          await checkCloud(true)
        }
        return model().cloud === "ready" && localConfigured
      }
      if (model().cloud !== "uninitialized") return false
      const confirmed = await confirmInitializeCloud(dialog)
      if (!confirmed) {
        if (automatic) await sdk.client.global.syncEnabled({ enabled: false }, { throwOnError: true })
        await refreshLocal()
        return false
      }
      await sdk.client.global.syncCloudInitialize({ throwOnError: true })
      await checkCloud(true)
      return model().cloud === "ready"
    }

    onInitializationRequired = async () => {
      if (initializationPrompt) return
      initializationPrompt = true
      try {
        await refreshLocal()
        if (!model().enabled) return
        if (!(await ensureCloud(true))) return
        await sdk.client.global.syncNow({ throwOnError: true })
      } catch (error) {
        const message = syncOperationFailure(error)
        setModel((current) => ({ ...current, state: "attention", detail: message }))
        toast.show({ message, variant: "error" })
      } finally {
        initializationPrompt = false
      }
    }

    const runSyncNow = async () => {
      if (!(await ensureCloud(false))) return
      setModel((current) => ({ ...current, state: "syncing" }))
      await sdk.client.global.syncNow({ throwOnError: true })
      await refreshLocal(true)
    }

    const applyPostLoginChoice = async () => {
      const choice = await showPostLoginSyncChoice(dialog)
      if (choice === "disabled" || choice === undefined) return refreshLocal()
      if (!(await ensureCloud(true))) return
      await sdk.client.global.syncEnabled({ enabled: true }, { throwOnError: true })
      await refreshLocal()
      if (choice === "enable-now") await runSyncNow()
    }

    const completeOAuth = async (
      response: { type: "loopback"; callbackURL: string } | { type: "manual"; code: string },
      showChoice = true,
    ) => {
      if (!oauth) throw new Error("OAuth attempt is missing")
      const input = { attemptID: oauth.attemptID, response }
      if (oauth.mode === "switch") await sdk.client.global.syncOAuthSwitchAccount(input, { throwOnError: true })
      else await sdk.client.global.syncOAuthComplete(input, { throwOnError: true })
      oauth = undefined
      await refreshLocal()
      if (showChoice) await applyPostLoginChoice()
    }

    const beginManual = async () => {
      const owner = dialog.stack.at(-1)?.element
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
        account: { state: "disconnected", oauth: { state: "manual", authorizationURL: result.data.authorizationURL } },
      }))
      await openBrowser(result.data.authorizationURL).catch(() => undefined)
      if (dialog.isCurrent(owner)) showSyncSettings(dialog, model, actions)
    }

    const beginOAuth = async (mode: "connect" | "switch" = "connect") => {
      let owner = dialog.stack.at(-1)?.element
      await sdk.client.global.syncInitialize({ deviceName: hostname() }, { throwOnError: true })
      const application = mode === "connect" ? await promptBaiduApplication(dialog) : undefined
      if (mode === "connect" && !application) return
      owner = dialog.stack.at(-1)?.element
      setModel((current) => ({
        ...current,
        account: { state: "disconnected", oauth: { state: "opening" } },
      }))
      if (dialog.isCurrent(owner)) {
        showSyncSettings(dialog, model, actions)
        owner = dialog.stack.at(-1)?.element
      }
      loopback?.close()
      loopback = createLoopbackCallback()
      const result = await sdk.client.global.syncOAuthBegin(
        { redirectURI: loopback.redirectURI, completion: "loopback", application },
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
      if (dialog.isCurrent(owner)) {
        showSyncSettings(dialog, model, actions)
        owner = dialog.stack.at(-1)?.element
      }
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
        await completeOAuth({ type: "loopback", callbackURL: callback.callbackURL }, dialog.isCurrent(owner))
        callback.respond({ status: "success" })
      } catch {
        callback.respond({ status: "error", detail: "Authorization could not be completed. Return to OpenCode." })
        throw new Error("Baidu Netdisk authorization failed")
      } finally {
        setTimeout(() => {
          loopback?.close()
          loopback = undefined
        }, 1_000)
      }
    }

    const mutate = async (effect: () => Promise<unknown>, remote = false) => {
      await effect()
      if (remote) await checkCloud(true)
      else await refreshLocal(true)
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
      checkCloud: () => checkCloud(true),
      initializeCloud: async () => {
        await sdk.client.global.syncCloudInitialize({ throwOnError: true })
        await checkCloud(true)
      },
      clearCloud: async () => {
        await sdk.client.global.syncCloudClear({ throwOnError: true })
        setModel((current) => ({ ...current, enabled: false, state: "off", cloud: "uninitialized", devices: [] }))
        await refreshLocal(true)
      },
      syncNow: runSyncNow,
      setEnabled: async (enabled) => {
        if (enabled && !(await ensureCloud(true))) return
        await sdk.client.global.syncEnabled({ enabled }, { throwOnError: true })
        await refreshLocal(true)
      },
      setInterval: (intervalSeconds) =>
        mutate(() => sdk.client.global.syncInterval({ intervalSeconds }, { throwOnError: true })),
      logout: async () => {
        await sdk.client.global.syncLogout({ throwOnError: true })
        setModel(initial)
      },
      revokeDevice: (id) =>
        mutate(() => sdk.client.global.syncDeviceUpdate({ id, revoke: true }, { throwOnError: true }), true),
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
              { portableTargetLabel, expectedRevision: bindingRevision, expectedSessionIDs: [...expectedSessionIDs] },
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
      onError: (error) => {
        const message = syncOperationFailure(error)
        setModel((current) => ({ ...current, state: "attention", detail: message }))
        toast.show({ message, variant: "error" })
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
        if (view === "devices") void checkCloud(true)
        else void refreshLocal(true)
        return "completed" as const
      },
      refresh: checkCloud,
    }
  },
})
