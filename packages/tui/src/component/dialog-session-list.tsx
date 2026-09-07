import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useProject } from "../context/project"
import { useTheme } from "../context/theme"
import { useSDK } from "../context/sdk"
import { useLocal } from "../context/local"
import { DialogSessionRename } from "./dialog-session-rename"
import { createDebouncedSignal } from "../util/signal"
import { useToast } from "../ui/toast"
import { openWorkspaceSelect, type WorkspaceSelection, warpWorkspaceSession } from "./dialog-workspace-create"
import { Spinner } from "./spinner"
import { errorMessage } from "../util/error"
import { DialogSessionDeleteFailed } from "./dialog-session-delete-failed"
import { useCommandShortcut } from "../keymap"
import { useEvent } from "../context/event"
import { sessionListLocation, sessionListMatches, type SessionListLocationRecord } from "./session-list-location"
import { DialogSessionLocationRecovery, forceRebindSession } from "./dialog-session-location-recovery"
import { useKV } from "../context/kv"
import { SESSION_FORCE_REBIND_SETTING } from "../command-toolkit/experimental-settings"
import path from "node:path"
import { TextAttributes } from "@opentui/core"
import { useTuiPaths } from "../context/runtime"

type SessionListFilter = { scope?: "project"; path?: string }
export type DialogSessionListFilters = {
  readonly focus: "cwd" | "scope"
  readonly cwd: "cwd" | "all"
  readonly scope: "current" | "all"
}

type SyncAvailability = "metadata-only" | "hydrating" | "ready" | "partial" | "conflict" | "unresolved"
type SyncedSession = {
  readonly sessionID: string
  readonly title: string
  readonly targetLabel?: string
  readonly sourceDeviceID: string
  readonly deleted?: boolean
  readonly directory: string
  readonly updatedAt: number
  readonly availability: SyncAvailability
}

type DialogSessionEntry = {
  readonly id: string
  readonly title: string
  readonly directory: string
  readonly path?: string
  readonly parentID?: string
  readonly workspaceID?: string
  readonly syncSpaceID?: string
  readonly targetLabel?: string
  readonly sourceDeviceID?: string
  readonly time: { readonly updated: number }
  readonly syncMetadata?: SyncedSession
}

export function updateDialogSessionListFilters(
  filters: DialogSessionListFilters,
  key: "tab" | "left" | "right",
): DialogSessionListFilters {
  if (key === "tab") return { ...filters, focus: filters.focus === "cwd" ? "scope" : "cwd" }
  if (filters.focus === "cwd") return { ...filters, cwd: filters.cwd === "cwd" ? "all" : "cwd" }
  return { ...filters, scope: filters.scope === "current" ? "all" : "current" }
}

export function dialogSessionListLocationFilter(input: {
  mode: DialogSessionListFilters["cwd"]
  worktree?: string
  directory?: string
}): SessionListFilter {
  if (input.mode === "all" || !input.worktree || !input.directory) return { scope: "project" }
  return { path: path.relative(path.resolve(input.worktree), input.directory).replaceAll("\\", "/") }
}

export function sessionInDialogSyncScope(
  session: { readonly syncSpaceID?: string },
  scope: DialogSessionListFilters["scope"],
  activeSpaceID?: string,
) {
  // Without an active space there is no meaningful "current" scope.  Keep
  // the default view useful by degrading it to the locally-held All view.
  if (scope === "all" || activeSpaceID === undefined) return true
  return activeSpaceID !== undefined && session.syncSpaceID === activeSpaceID
}

export function includeCloudSessionInDialogScope(scope: DialogSessionListFilters["scope"], activeSpaceID?: string) {
  // The API exposes cloud-only metadata for the active space only.  Both
  // views may include that already-fetched metadata; All must never fetch a
  // non-active space to fill the list.
  return activeSpaceID !== undefined
}

export function syncAvailabilityLabel(availability: SyncAvailability) {
  return {
    "metadata-only": "◐ metadata-only",
    hydrating: "◐ hydrating",
    ready: "● ready",
    partial: "! partial",
    conflict: "! conflict",
    unresolved: "! unresolved",
  }[availability]
}

function fromSyncedSession(session: SyncedSession): DialogSessionEntry {
  return {
    id: session.sessionID,
    title: session.title,
    directory: session.directory,
    targetLabel: session.targetLabel,
    sourceDeviceID: session.sourceDeviceID,
    time: { updated: session.updatedAt },
    syncMetadata: session,
  }
}

export function createDialogSessionListQuery(input: { search?: string; filter: SessionListFilter }) {
  const search = input.search?.trim()
  return {
    roots: true,
    limit: search ? 30 : 100,
    ...(search ? { search } : {}),
    ...input.filter,
  }
}

export function loadDialogSessionList<T>(input: {
  search?: string
  filter: SessionListFilter
  list: (query: ReturnType<typeof createDialogSessionListQuery>) => Promise<{ data?: T[] }>
}) {
  return input.list(createDialogSessionListQuery(input)).then(
    (result) => result.data,
    () => undefined,
  )
}

export function DialogSessionList() {
  const dialog = useDialog()
  const route = useRoute()
  const sync = useSync()
  const project = useProject()
  const { theme } = useTheme()
  const sdk = useSDK()
  const paths = useTuiPaths()
  const event = useEvent()
  const kv = useKV()
  const local = useLocal()
  const toast = useToast()
  const [toDelete, setToDelete] = createSignal<string>()
  const [deleted, setDeleted] = createSignal(new Set<string>())
  const [search, setSearch] = createDebouncedSignal("", 150)
  const [filters, setFilters] = createSignal<DialogSessionListFilters>({
    focus: "cwd",
    cwd: kv.get("session_directory_filter_enabled", true) ? "cwd" : "all",
    scope: "current",
  })
  const deleteHint = useCommandShortcut("session.delete")
  const quickSwitch1 = useCommandShortcut("session.quick_switch.1")
  const quickSwitch9 = useCommandShortcut("session.quick_switch.9")

  const locationFilter = createMemo(() =>
    dialogSessionListLocationFilter({
      mode: filters().cwd,
      worktree: project.data.instance.path.worktree,
      directory: project.data.instance.path.directory,
    }),
  )
  const [browseResults, { refetch: refetchBrowse }] = createResource(locationFilter, (filter) =>
    loadDialogSessionList({ filter, list: (query) => sdk.client.session.list(query) }),
  )
  const [searchResults, { refetch }] = createResource(
    () => ({ query: search(), filter: locationFilter() }),
    (input) => {
      if (!input.query) return undefined
      return loadDialogSessionList({
        search: input.query,
        filter: input.filter,
        list: (query) => sdk.client.session.list(query),
      })
    },
  )
  const [syncScope, { refetch: refetchSyncedSessions }] = createResource(
    async (): Promise<{
      activeSpaceID?: string
      sessions: SyncedSession[]
    }> => {
      try {
        const [status, sessions] = await Promise.all([sdk.client.global.syncStatus(), sdk.client.global.syncSessions()])
        const activeSpaceID = status.data?.namespaceID
        return { activeSpaceID, sessions: activeSpaceID ? ((sessions.data ?? []) as SyncedSession[]) : [] }
      } catch {
        // Sync is optional. A local session list remains usable when the secure
        // store is locked, sync is not configured, or the provider is offline.
        return { sessions: [] }
      }
    },
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const sessions = createMemo(() => {
    const searched = searchResults()
    const browsed = browseResults() ?? sync.data.session
    // The upstream server search only knows about titles. Keep its wider title
    // matches, but merge the reusable browse query so location/device fields can
    // be searched locally without teaching this component about sync transport.
    const result = searched
      ? [...searched, ...browsed.filter((candidate) => !searched.some((item) => item.id === candidate.id))]
      : browsed
    const synced = new Map(sync.data.session.map((session) => [session.id, session]))
    const activeSpaceID = syncScope()?.activeSpaceID
    const remote = new Map((syncScope()?.sessions ?? []).map((session) => [session.sessionID, session]))
    const ids = new Set(result.map((session) => session.id))
    const extra = [currentSessionID(), ...local.session.pinned()].flatMap((id) => {
      if (!id || ids.has(id)) return []
      const session = synced.get(id)
      if (session) ids.add(id)
      return session ? [session] : []
    })
    const query = search().trim().toLowerCase()
    const remoteOnly = (includeCloudSessionInDialogScope(filters().scope, activeSpaceID) ? [...remote.values()] : [])
      .filter((session) => !ids.has(session.sessionID))
      .filter((session) => !session.deleted)
      .map(fromSyncedSession)
    const localEntry = (session: (typeof sync.data.session)[number]): DialogSessionEntry => ({
      ...session,
      targetLabel: remote.get(session.id)?.targetLabel,
      sourceDeviceID: remote.get(session.id)?.sourceDeviceID,
      syncMetadata: remote.get(session.id),
    })
    return [
      ...result.map((session) => localEntry(synced.get(session.id) ?? session)),
      ...extra.map(localEntry),
      ...remoteOnly,
    ]
      .filter((session) => !deleted().has(session.id))
      .filter((session) => session.syncMetadata || sessionInDialogSyncScope(session, filters().scope, activeSpaceID))
      .filter((session) => sessionListMatches(session as typeof session & SessionListLocationRecord, query))
  })

  onCleanup(
    event.on("session.deleted", (event) => {
      setDeleted((current) => new Set(current).add(event.properties.info.id))
    }),
  )

  function recover(session: DialogSessionEntry) {
    const workspace = project.workspace.get(session.workspaceID!)
    const list = () => dialog.replace(() => <DialogSessionList />)
    const warp = async (selection: WorkspaceSelection) => {
      const workspaceID = await (async () => {
        if (selection.type === "none") return null
        if (selection.type === "existing") return selection.workspaceID
        let result
        try {
          result = await sdk.client.experimental.workspace.create({ type: selection.workspaceType, branch: null })
        } catch (err) {
          toast.show({
            title: "Failed to create workspace",
            message: errorMessage(err),
            variant: "error",
          })
          return
        }
        const workspace = result?.data
        if (!workspace) {
          toast.show({
            title: "Failed to create workspace",
            message: errorMessage(result?.error ?? "no response"),
            variant: "error",
          })
          return
        }
        await project.workspace.sync()
        return workspace.id
      })()
      if (workspaceID === undefined) return
      await warpWorkspaceSession({
        dialog,
        sdk,
        sync,
        project,
        toast,
        sourceWorkspaceID: session.workspaceID,
        workspaceID,
        sessionID: session.id,
        copyChanges: false,
        done: list,
      })
    }
    dialog.replace(() => (
      <DialogSessionDeleteFailed
        session={session.title}
        workspace={workspace?.name ?? session.workspaceID!}
        onDone={list}
        onDelete={async () => {
          const current = currentSessionID()
          const info = current ? sync.data.session.find((item) => item.id === current) : undefined
          const result = await sdk.client.experimental.workspace.remove({ id: session.workspaceID! })
          if (result.error) {
            toast.show({
              variant: "error",
              title: "Failed to delete workspace",
              message: errorMessage(result.error),
            })
            return false
          }
          await project.workspace.sync()
          await sync.session.refresh()
          await refetchBrowse()
          if (search()) await refetch()
          if (info?.workspaceID === session.workspaceID) {
            route.navigate({ type: "home" })
          }
          return true
        }}
        onRestore={() => {
          void openWorkspaceSelect({
            dialog,
            sdk,
            sync,
            project,
            toast,
            onSelect: (selection) => {
              void warp(selection)
            },
          })
          return false
        }}
      />
    ))
  }

  function orderByRecency(sessionsList: NonNullable<ReturnType<typeof sessions>>) {
    return sessionsList
      .filter((x) => x.parentID === undefined)
      .toSorted((a, b) => b.time.updated - a.time.updated)
      .map((x) => x.id)
  }

  const browseOrder = createMemo(() => orderByRecency(sessions()))

  const quickSwitchHint = createMemo(() => {
    const first = quickSwitch1()
    const last = quickSwitch9()
    if (!first || !last) return undefined
    return quickSwitchRange(first, last)
  })
  const quickSwitchFooterHints = createMemo(() => {
    const hint = quickSwitchHint()
    return hint && local.session.slots().length > 0 ? [{ title: "switch", label: hint }] : []
  })

  const options = createMemo(() => {
    const today = new Date().toDateString()
    const sessionMap = new Map(
      sessions()
        .filter((x) => x.parentID === undefined)
        .map((x) => [x.id, x]),
    )

    const searchResult = searchResults()
    const order = searchResult ? orderByRecency(sessions()) : browseOrder()
    const current = currentSessionID()
    const displayOrder = current && sessionMap.has(current) && !order.includes(current) ? [...order, current] : order

    const pinned = local.session.pinned().filter((id) => sessionMap.has(id))
    const pinnedSet = new Set(pinned)
    const slotByID = new Map<string, number>(local.session.slots().map((id, i) => [id, i + 1]))

    function buildOption(id: string, category: string) {
      const x = sessionMap.get(id)
      if (!x) return undefined
      const location = sessionListLocation(x as typeof x & SessionListLocationRecord)
      const footer = location.label
      const syncStatus = x.syncMetadata ? syncAvailabilityLabel(x.syncMetadata.availability) : undefined

      const isDeleting = toDelete() === x.id
      const status = sync.data.session_status?.[x.id]
      const isWorking = status?.type === "busy" || status?.type === "retry"
      const slot = slotByID.get(x.id)
      const gutter = isWorking
        ? () => <Spinner />
        : slot !== undefined
          ? () => <text fg={theme.accent}>{slot}</text>
          : undefined
      return {
        title: isDeleting ? `Press ${deleteHint()} again to confirm` : x.title,
        bg: isDeleting ? theme.error : undefined,
        value: x.id,
        category,
        footer: [footer, syncStatus].filter(Boolean).join(" · "),
        gutter,
      }
    }

    const remaining = displayOrder
      .filter((id) => !pinnedSet.has(id))
      .map((id) => {
        const x = sessionMap.get(id)
        if (!x) return undefined
        const label = new Date(x.time.updated).toDateString()
        return buildOption(id, label === today ? "Today" : label)
      })
      .filter((x) => x !== undefined)

    return [...pinned.map((id) => buildOption(id, "Pinned")).filter((x) => x !== undefined), ...remaining]
  })

  onMount(() => {
    dialog.setSize("large")
  })

  return (
    <DialogSelect
      title="Sessions"
      titleView={
        <box flexDirection="column">
          <text fg={theme.text} attributes={TextAttributes.BOLD}>
            Sessions
          </text>
          <SessionFilterRow
            title="Filter"
            values={["Cwd", "All"]}
            selected={filters().cwd === "cwd" ? 0 : 1}
            focused={filters().focus === "cwd"}
          />
          <SessionFilterRow
            title="Scope"
            values={["Current Sync Space", "All"]}
            selected={filters().scope === "current" && syncScope()?.activeSpaceID !== undefined ? 0 : 1}
            focused={filters().focus === "scope"}
          />
        </box>
      }
      options={options()}
      skipFilter={true}
      preserveSelection={true}
      current={currentSessionID()}
      onFilter={setSearch}
      onMove={() => {
        setToDelete(undefined)
      }}
      onSelect={async (option) => {
        const selected = sessions().find((session) => session.id === option.value)
        const remote = selected?.syncMetadata
        if (
          remote &&
          (!sync.data.session.some((session) => session.id === option.value) || remote.availability === "partial")
        ) {
          try {
            const result = await sdk.client.global.syncHydrate({ sessionID: option.value }, { throwOnError: true })
            await Promise.all([sync.session.refresh(), refetchSyncedSessions()])
            if (!["ready", "conflict", "unresolved"].includes(result.data.availability)) {
              toast.show({
                title: "Session is not ready",
                message: syncAvailabilityLabel(result.data.availability),
                variant: "error",
              })
              return
            }
            if (result.data.availability === "conflict") {
              toast.show({
                title: "Opened a conflict copy",
                message: "The remote history diverged. Review this session before making further changes.",
                variant: "error",
              })
            }
          } catch (err) {
            await refetchSyncedSessions()
            toast.show({ title: "Failed to download session", message: errorMessage(err), variant: "error" })
            return
          }
        }
        try {
          const result = await sdk.client.v2.sessionLocation.resolve(
            { sessionID: option.value },
            { throwOnError: true },
          )
          const resolution = result.data
          if (resolution.status === "resolved") {
            route.navigate({ type: "session", sessionID: option.value, accessMode: "read-write" })
            dialog.clear()
            return
          }
          dialog.replace(() => <DialogSessionLocationRecovery sessionID={option.value} resolution={resolution} />)
        } catch (cause) {
          toast.show({ title: "Session target resolution failed", message: errorMessage(cause), variant: "error" })
        }
      }}
      actions={[
        ...(kv.get(SESSION_FORCE_REBIND_SETTING, false)
          ? [
              {
                command: "session.location.rebind",
                title: "force rebind (experimental)",
                onTrigger: (option: { value: string }) => {
                  const session = sessions().find((item) => item.id === option.value)
                  if (!session) return
                  void sdk.client.v2.session
                    .get({ sessionID: session.id }, { throwOnError: true })
                    .then((current) =>
                      forceRebindSession({
                        dialog,
                        sdk,
                        sessionID: session.id,
                        expectedRevision: current.data.data.locationRevision ?? 0,
                        currentDirectory: current.data.data.location.directory,
                        localHome: paths.home,
                      }),
                    )
                    .then(() => sync.session.refresh())
                    .catch((cause) =>
                      toast.show({ title: "Location rebind failed", message: errorMessage(cause), variant: "error" }),
                    )
                },
              },
            ]
          : []),
        {
          command: "session.pin.toggle",
          title: "pin/unpin",
          onTrigger: (option: { value: string }) => {
            local.session.togglePin(option.value)
          },
        },
        {
          command: "session.delete",
          title: "delete",
          onTrigger: async (option) => {
            if (toDelete() === option.value) {
              const session = sessions().find((item) => item.id === option.value)
              const status = session?.workspaceID ? project.workspace.status(session.workspaceID) : undefined

              try {
                const result = await sdk.client.session.delete({
                  sessionID: option.value,
                })
                if (result.error) {
                  if (session?.workspaceID) {
                    recover(session)
                  } else {
                    toast.show({
                      variant: "error",
                      title: "Failed to delete session",
                      message: errorMessage(result.error),
                    })
                  }
                  setToDelete(undefined)
                  return
                }
              } catch (err) {
                if (session?.workspaceID) {
                  recover(session)
                } else {
                  toast.show({
                    variant: "error",
                    title: "Failed to delete session",
                    message: errorMessage(err),
                  })
                }
                setToDelete(undefined)
                return
              }
              if (status && status !== "connected") {
                await sync.session.refresh()
              }
              await refetchBrowse()
              if (search()) await refetch()
              setToDelete(undefined)
              return
            }
            setToDelete(option.value)
          },
        },
        {
          command: "session.rename",
          title: "rename",
          onTrigger: async (option) => {
            dialog.replace(() => <DialogSessionRename session={option.value} />)
          },
        },
      ]}
      footerHints={quickSwitchFooterHints()}
      bindings={(["tab", "left", "right"] as const).map((key) => ({
        key,
        desc: key === "tab" ? "Switch Session filter row" : "Change Session filter",
        group: "Dialog",
        cmd: () => {
          setFilters((current) => updateDialogSessionListFilters(current, key))
        },
      }))}
    />
  )
}

function SessionFilterRow(props: {
  title: string
  values: readonly [string, string]
  selected: number
  focused: boolean
}) {
  const { theme } = useTheme()
  return (
    <text fg={props.focused ? theme.text : theme.textMuted}>
      {props.title}: {props.selected === 0 ? `[${props.values[0]}]` : props.values[0]}{" "}
      {props.selected === 1 ? `[${props.values[1]}]` : props.values[1]}
    </text>
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
