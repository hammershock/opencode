import { createSignal, onCleanup, onMount } from "solid-js"
import type { GlobalSyncDiscoverResponse } from "@opencode-ai/sdk/v2"
import { OauthCallbackPage } from "@opencode-ai/core/oauth/page"
import { hostname } from "node:os"
import openBrowser from "open"
import { createSimpleContext } from "./helper"
import { useSDK } from "./sdk"
import { useKV } from "./kv"
import { useClipboard } from "./clipboard"
import { useDialog } from "../ui/dialog"
import { useToast } from "../ui/toast"
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
  spaces: [],
  devices: [],
  bindings: [],
  pending: 0,
  unassigned: [],
}

export function unassignedFingerprint(spaceID: string, sessionIDs: readonly string[]) {
  return `${spaceID}\n${sessionIDs.slice().sort().join("\n")}`
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

    onCleanup(() => loopback?.close())

    const refresh = async (discover = false, notify = false) => {
      const state = await sdk.client.global.syncState({ throwOnError: true }).then(
        (result) => result.data,
        () => undefined,
      )
      const status = await sdk.client.global.syncStatus({ throwOnError: true }).then(
        (result) => result.data,
        () => undefined,
      )
      if (!state) {
        setModel((current) => ({ ...initial, account: current.account, state: status ? "attention" : "off" }))
        if (!status && notify) toast.show({ message: "Sync status is unavailable", variant: "warning" })
        return
      }
      const authenticated = Boolean(status?.authenticated)
      let attention = status === undefined
      if (discover && authenticated) {
        const result = await sdk.client.global.syncDiscover({ throwOnError: true }).then(
          (value) => value.data,
          () => undefined,
        )
        if (result) discovered = result.spaces
        else attention = true
      }
      const activeSessions = state.activeSpaceID
        ? await sdk.client.global.syncSessions({ throwOnError: true }).then(
            (result) => result.data,
            () => {
              attention = true
              return []
            },
          )
        : []
      const deviceResult = state.activeSpaceID
        ? await sdk.client.global.syncDevices({ throwOnError: true }).then(
            (result) => result.data,
            () => {
              attention = true
              return undefined
            },
          )
        : undefined
      const bindingResult = authenticated
        ? await sdk.client.v2.targetBinding.list({ throwOnError: true }).then(
            (result) => result.data,
            () => {
              attention = true
              return undefined
            },
          )
        : undefined
      if (bindingResult) bindingRevision = bindingResult.revision
      const unassigned = authenticated
        ? await sdk.client.global.syncUnassigned({ throwOnError: true }).then(
            (result) => result.data,
            () => {
              attention = true
              return []
            },
          )
        : []
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
      setModel({
        account:
          authenticated && status?.account
            ? { state: "connected", maskedAccount: status.account.maskedDisplay }
            : model().account.state === "disconnected"
              ? model().account
              : initial.account,
        enabled: state.enabled,
        interval: state.intervalSeconds,
        state: stateName,
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
        setModel((current) => ({ ...current, state: "syncing" }))
        await mutate(() => sdk.client.global.syncNow({ throwOnError: true }))
      },
      setEnabled: (enabled) => mutate(() => sdk.client.global.syncEnabled({ enabled }, { throwOnError: true })),
      setInterval: (intervalSeconds) =>
        mutate(() => sdk.client.global.syncInterval({ intervalSeconds }, { throwOnError: true })),
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
      onError: () => {
        setModel((current) => ({ ...current, state: "attention", detail: "Sync operation failed" }))
        toast.show({ message: "Sync operation failed", variant: "error" })
        void refresh(true)
      },
    }

    const render = (view: OpenView) => {
      if (view === "devices") return showSyncDevices(dialog, model, actions)
      showSyncSettings(dialog, model, actions)
    }

    onMount(() => void refresh())

    return {
      model,
      status: () => syncStatus(model().state),
      async open(view: OpenView = "overview") {
        try {
          await refresh(true, true)
          if (view === "overview") await assignPrompt(false)
          render(view)
          return "completed" as const
        } catch (error) {
          actions.onError(error)
          return "failed" as const
        }
      },
      refresh,
    }
  },
})
