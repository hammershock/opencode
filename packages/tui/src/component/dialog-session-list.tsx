import { useDialog } from "../ui/dialog"
import { DialogSelect } from "../ui/dialog-select"
import { useRoute } from "../context/route"
import { useSync } from "../context/sync"
import { createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
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
import {
  sessionListFooter,
  sessionListLocation,
  sessionListMatches,
  type SessionListLocationRecord,
} from "./session-list-location"
import { DialogSessionLocationRecovery, forceRebindSession } from "./dialog-session-location-recovery"
import { useKV } from "../context/kv"
import { SESSION_FORCE_REBIND_SETTING } from "../command-toolkit/experimental-settings"
import path from "node:path"
import { TextAttributes } from "@opentui/core"
import { useTuiPaths } from "../context/runtime"

type SessionListFilter = { scope?: "project"; path?: string }
export type DialogSessionListFilters = {
  readonly focus: "cwd" | "target"
  readonly cwd: "cwd" | "all"
  readonly target: string
}

export const SESSION_FILTER_FOOTER_HINT = { title: "tab", label: "filters" } as const

type SyncAvailability = "metadata-only" | "hydrating" | "ready" | "partial" | "conflict" | "unresolved"
type SyncedSession = {
  readonly sessionID: string
  readonly title: string
  readonly ownerDeviceID: string
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
  readonly cloudOnly?: boolean
  readonly time: { readonly updated: number }
  readonly syncMetadata?: SyncedSession
}

export function updateDialogSessionListFilters(
  filters: DialogSessionListFilters,
  key: "tab" | "left" | "right",
  targets: readonly string[] = ["local", "all"],
): DialogSessionListFilters {
  if (key === "tab") return { ...filters, focus: filters.focus === "cwd" ? "target" : "cwd" }
  if (filters.focus === "cwd") {
    const cwd = filters.cwd === "cwd" ? "all" : "cwd"
    return { ...filters, cwd, target: cwd === "cwd" ? "local" : filters.target }
  }
  const current = Math.max(0, targets.indexOf(filters.target))
  const offset = key === "right" ? 1 : -1
  const target = targets[(current + offset + targets.length) % targets.length] ?? "local"
  return { ...filters, target, cwd: target === "local" ? filters.cwd : "all" }
}

export function dialogSessionListLocationFilter(input: {
  mode: DialogSessionListFilters["cwd"]
  worktree?: string
  directory?: string
}): SessionListFilter {
  if (input.mode === "all" || !input.worktree || !input.directory) return { scope: "project" }
  return { path: path.relative(path.resolve(input.worktree), input.directory).replaceAll("\\", "/") }
}

export function dialogSessionListTargetOptions(sessions: readonly SessionListLocationRecord[], selected = "local") {
  const remote = sessions
    .map((session) => sessionListLocation(session).target)
    .filter((target) => target !== "local" && target !== "all")
    .toSorted((a, b) => a.localeCompare(b))
  return ["local", "all", ...new Set([...remote, ...(selected === "local" || selected === "all" ? [] : [selected])])]
}

export function sessionInDialogTarget(session: SessionListLocationRecord, target: string) {
  return target === "all" || sessionListLocation(session).target === target
}

export function dialogSessionListTargetLabel(input: {
  readonly lastKnownTargetName?: string
  readonly remote?: Pick<SyncedSession, "ownerDeviceID" | "targetLabel">
  readonly currentDeviceID?: string
}) {
  if (input.remote?.ownerDeviceID === input.currentDeviceID) return input.lastKnownTargetName
  return input.remote?.targetLabel ?? input.lastKnownTargetName
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

export function dialogSessionListSyncStatus(session: Pick<DialogSessionEntry, "cloudOnly" | "syncMetadata">) {
  if (session.cloudOnly) return "cloud"
  return session.syncMetadata ? syncAvailabilityLabel(session.syncMetadata.availability) : undefined
}

function fromSyncedSession(session: SyncedSession): DialogSessionEntry {
  return {
    id: session.sessionID,
    title: session.title,
    directory: session.directory,
    targetLabel: session.targetLabel,
    sourceDeviceID: session.sourceDeviceID,
    cloudOnly: true,
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
  const dimensions = useTerminalDimensions()
  const [toDelete, setToDelete] = createSignal<string>()
  const [deleted, setDeleted] = createSignal(new Set<string>())
  const [search, setSearch] = createDebouncedSignal("", 150)
  const savedTarget = kv.get("session_target_filter", "local")
  const rememberedTarget = typeof savedTarget === "string" && savedTarget.trim() ? savedTarget : "local"
  const [filters, setFilters] = createSignal<DialogSessionListFilters>({
    focus: "cwd",
    cwd: kv.get("session_directory_filter_enabled", true) && rememberedTarget === "local" ? "cwd" : "all",
    target: rememberedTarget,
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
  const [cloudSessions, { refetch: refetchSyncedSessions }] = createResource(
    async (): Promise<{
      readonly deviceID?: string
      readonly sessions: SyncedSession[]
    }> => {
      try {
        const [status, sessions] = await Promise.all([sdk.client.global.syncStatus(), sdk.client.global.syncSessions()])
        return { deviceID: status.data?.deviceID, sessions: (sessions.data ?? []) as SyncedSession[] }
      } catch {
        // Sync is optional. A local session list remains usable when the secure
        // store is locked, sync is not configured, or the provider is offline.
        return { sessions: [] }
      }
    },
  )

  const currentSessionID = createMemo(() => (route.data.type === "session" ? route.data.sessionID : undefined))
  const allSessions = createMemo(() => {
    const searched = searchResults()
    const browsed = browseResults() ?? sync.data.session
    // The upstream server search only knows about titles. Keep its wider title
    // matches, but merge the reusable browse query so location/device fields can
    // be searched locally without teaching this component about sync transport.
    const result = searched
      ? [...searched, ...browsed.filter((candidate) => !searched.some((item) => item.id === candidate.id))]
      : browsed
    const synced = new Map(sync.data.session.map((session) => [session.id, session]))
    const remote = new Map((cloudSessions()?.sessions ?? []).map((session) => [session.sessionID, session]))
    const ids = new Set(result.map((session) => session.id))
    const extra = [currentSessionID(), ...local.session.pinned()].flatMap((id) => {
      if (!id || ids.has(id)) return []
      const session = synced.get(id)
      if (session) ids.add(id)
      return session ? [session] : []
    })
    const query = search().trim().toLowerCase()
    const remoteOnly = [...remote.values()]
      .filter((session) => !ids.has(session.sessionID))
      .filter((session) => !session.deleted)
      .map(fromSyncedSession)
    const localEntry = (session: (typeof sync.data.session)[number]): DialogSessionEntry => ({
      ...session,
      targetLabel: dialogSessionListTargetLabel({
        lastKnownTargetName: session.lastKnownTargetName,
        remote: remote.get(session.id),
        currentDeviceID: cloudSessions()?.deviceID,
      }),
      sourceDeviceID: remote.get(session.id)?.sourceDeviceID,
      syncMetadata: remote.get(session.id),
    })
    return [
      ...result.map((session) => localEntry(synced.get(session.id) ?? session)),
      ...extra.map(localEntry),
      ...remoteOnly,
    ]
      .filter((session) => !deleted().has(session.id))
      .filter((session) => sessionListMatches(session as typeof session & SessionListLocationRecord, query))
  })
  const targetOptions = createMemo(() =>
    dialogSessionListTargetOptions(
      allSessions() as (DialogSessionEntry & SessionListLocationRecord)[],
      filters().target,
    ),
  )
  const sessions = createMemo(() =>
    allSessions().filter((session) =>
      sessionInDialogTarget(session as typeof session & SessionListLocationRecord, filters().target),
    ),
  )

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
      const syncStatus = dialogSessionListSyncStatus(x)
      const footer = sessionListFooter(
        location,
        syncStatus,
        Math.max(12, Math.floor((Math.min(88, dimensions().width - 2) - 8) * 0.6)),
      )

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
        footer: footer.text,
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
            title="Path"
            values={["Cwd", "All"]}
            selected={filters().cwd === "cwd" ? 0 : 1}
            focused={filters().focus === "cwd"}
          />
          <SessionFilterRow
            title="Target"
            values={targetOptions().map((target) => (target === "all" ? "All" : target))}
            selected={Math.max(0, targetOptions().indexOf(filters().target))}
            focused={filters().focus === "target"}
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
      footerHints={[SESSION_FILTER_FOOTER_HINT, ...quickSwitchFooterHints()]}
      bindings={(["tab", "left", "right"] as const).map((key) => ({
        key,
        desc: key === "tab" ? "Switch Session filter row" : "Change Session filter",
        group: "Dialog",
        cmd: () => {
          const next = updateDialogSessionListFilters(filters(), key, targetOptions())
          setFilters(next)
          kv.set("session_directory_filter_enabled", next.cwd === "cwd")
          kv.set("session_target_filter", next.target)
        },
      }))}
    />
  )
}

function SessionFilterRow(props: { title: string; values: readonly string[]; selected: number; focused: boolean }) {
  const { theme } = useTheme()
  return (
    <text fg={props.focused ? theme.text : theme.textMuted}>
      {props.title}: {props.values.map((value, index) => (props.selected === index ? `[${value}]` : value)).join(" ")}
    </text>
  )
}

function quickSwitchRange(first: string, last: string) {
  const prefix = first.slice(0, -1)
  if (first.endsWith("1") && last === `${prefix}9`) return `${prefix}1-9`
  return `${first} through ${last}`
}
