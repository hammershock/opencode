import { createEffect, createMemo, createSignal, on, onCleanup, onMount } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import {
  formatTime,
  load,
  meterDetails,
  orderedMeters,
  status as usageStatus,
  type Meter,
  type Result,
} from "../provider-usage"
import { useSDK } from "../context/sdk"

function providerID(value: unknown) {
  if (!value || typeof value !== "object" || !("providerID" in value)) return
  return typeof value.providerID === "string" ? value.providerID : undefined
}

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const [query, setQuery] = createSignal("")
  const [usage, setUsage] = createSignal<Record<string, Result>>({})
  const requests = new Map<string, AbortController>()

  function queryUsage(providerID: string, refresh = false) {
    requests.get(providerID)?.abort()
    const controller = new AbortController()
    requests.set(providerID, controller)
    void load(sdk, providerID, refresh, controller.signal)
      .then((result) => {
        if (requests.get(providerID) !== controller) return
        setUsage((current) => ({ ...current, [providerID]: result }))
      })
      .catch(() => {})
      .finally(() => {
        if (requests.get(providerID) === controller) requests.delete(providerID)
      })
  }

  createEffect(
    on(
      () => sync.data.provider.map((provider) => provider.id).join("\0"),
      () => {
        for (const provider of sync.data.provider) {
          if (usage()[provider.id] || requests.has(provider.id)) continue
          queryUsage(provider.id)
        }
      },
      { defer: false },
    ),
  )
  onCleanup(() => requests.forEach((controller) => controller.abort()))

  const connected = useConnected()
  const providers = createDialogProviderOptions()

  const showExtra = createMemo(() => connected() && !props.providerID)

  const options = createMemo(() => {
    const needle = query().trim()
    const showSections = showExtra() && needle.length === 0
    const favorites = connected() ? local.model.favorite() : []
    const recents = local.model.recent()

    function toOptions(items: typeof favorites, category: string) {
      if (!showSections) return []
      return items.flatMap((item) => {
        const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
        if (!provider) return []
        const model = provider.models[item.modelID]
        if (!model) return []
        return [
          {
            key: item,
            value: { providerID: provider.id, modelID: model.id },
            title: model.name ?? item.modelID,
            description: provider.name,
            category,
            disabled: provider.id === "opencode" && model.id.includes("-nano"),
            footer: connected()
              ? usageStatus(usage()[provider.id])
              : model.cost?.input === 0 && provider.id === "opencode"
                ? "Free"
                : undefined,
            onSelect: () => {
              onSelect(provider.id, model.id)
            },
          },
        ]
      })
    }

    const favoriteOptions = favorites.flatMap((item) => {
      const provider = sync.data.provider.find((provider) => provider.id === item.providerID)
      if (!provider) return []
      return toOptions([item], `Favorites · ${provider.name}`)
    })
    const recentOptions = toOptions(
      recents.filter(
        (item) => !favorites.some((fav) => fav.providerID === item.providerID && fav.modelID === item.modelID),
      ),
      "Recent",
    )

    const providerOptions = pipe(
      sync.data.provider,
      sortBy(
        (provider) => provider.id !== "opencode",
        (provider) => provider.name,
      ),
      flatMap((provider) =>
        pipe(
          provider.models,
          entries(),
          filter(([_, info]) => info.status !== "deprecated"),
          filter(([_, info]) => (props.providerID ? info.providerID === props.providerID : true)),
          map(([model, info]) => ({
            value: { providerID: provider.id, modelID: model },
            title: info.name ?? model,
            releaseDate: info.release_date,
            description: favorites.some((item) => item.providerID === provider.id && item.modelID === model)
              ? "(Favorite)"
              : undefined,
            category: connected() ? provider.name : undefined,
            disabled: provider.id === "opencode" && model.includes("-nano"),
            footer: connected()
              ? usageStatus(usage()[provider.id])
              : info.cost?.input === 0 && provider.id === "opencode"
                ? "Free"
                : undefined,
            onSelect() {
              onSelect(provider.id, model)
            },
          })),
          filter((option) => {
            if (!showSections) return true
            if (
              favorites.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            if (
              recents.some(
                (item) => item.providerID === option.value.providerID && item.modelID === option.value.modelID,
              )
            )
              return false
            return true
          }),
          (options) => sortModelOptions(options, props.providerID !== undefined),
        ),
      ),
    )

    const popularProviders = !connected()
      ? pipe(
          providers(),
          map((option) => ({
            ...option,
            category: "Popular providers",
          })),
          take(6),
        )
      : []

    if (needle) {
      return [
        ...sortModelOptions(
          fuzzysort.go(needle, providerOptions, { keys: ["title", "category"] }).map((x) => x.obj),
          false,
        ),
        ...fuzzysort.go(needle, popularProviders, { keys: ["title"] }).map((x) => x.obj),
      ]
    }

    return [...favoriteOptions, ...recentOptions, ...providerOptions, ...popularProviders]
  })

  const provider = createMemo(() =>
    props.providerID ? sync.data.provider.find((item) => item.id === props.providerID) : null,
  )

  const title = createMemo(() => {
    const value = provider()
    if (!value) return "Select model"
    return value.name
  })

  function onSelect(providerID: string, modelID: string) {
    local.model.set({ providerID, modelID }, { recent: true })
    const list = local.model.variant.list()
    const cur = local.model.variant.selected()
    if (cur === "default" || (cur && list.includes(cur))) {
      dialog.clear()
      return
    }
    if (list.length > 0) {
      dialog.replace(() => <DialogVariant />)
      return
    }
    dialog.clear()
  }

  return (
    <DialogSelect<ReturnType<typeof options>[number]["value"]>
      options={options()}
      actions={[
        {
          command: "model.dialog.usage.view",
          title: "View provider usage",
          hidden: !connected(),
          onTrigger: (option) => {
            const id = providerID(option.value)
            if (!id) return
            const provider = sync.data.provider.find((item) => item.id === id)
            dialog.replace(() => (
              <DialogProviderUsageDetails providerID={id} providerName={provider?.name ?? id} initial={usage()[id]} />
            ))
          },
        },
        {
          command: "model.dialog.usage.configure",
          title: "Configure footer usage",
          hidden: !connected(),
          disabled: (option) => {
            const id = providerID(option?.value)
            return !id || !usage()[id]?.snapshot?.meters.length
          },
          onTrigger: (option) => {
            const id = providerID(option.value)
            if (!id) return
            const meters = usage()[id]?.snapshot?.meters
            if (!meters?.length) return
            dialog.replace(() => <DialogProviderUsage providerID={id} meters={meters} />)
          },
        },
        {
          command: "model.dialog.usage.refresh",
          title: "Refresh provider usage",
          hidden: !connected(),
          onTrigger: (option) => {
            const id = providerID(option.value)
            if (id) queryUsage(id, true)
          },
        },
        {
          command: "model.dialog.provider",
          title: connected() ? "Connect provider" : "View all providers",
          onTrigger() {
            dialog.replace(() => <DialogProvider />)
          },
        },
        {
          command: "model.dialog.favorite",
          title: "Favorite",
          hidden: !connected(),
          onTrigger: (option) => {
            local.model.toggleFavorite(option.value as { providerID: string; modelID: string })
          },
        },
      ]}
      onFilter={setQuery}
      flat={true}
      skipFilter={true}
      title={title()}
      current={local.model.current()}
    />
  )
}

function DialogProviderUsageDetails(props: { providerID: string; providerName: string; initial?: Result }) {
  const sdk = useSDK()
  const dialog = useDialog()
  const [result, setResult] = createSignal(props.initial)
  const [refreshing, setRefreshing] = createSignal(false)
  let controller: AbortController | undefined

  function refresh() {
    controller?.abort()
    controller = new AbortController()
    setRefreshing(true)
    void load(sdk, props.providerID, true, controller.signal)
      .then(setResult)
      .catch(() => {})
      .finally(() => setRefreshing(false))
  }

  onMount(() => {
    if (!props.initial) refresh()
  })
  onCleanup(() => controller?.abort())

  const meters = createMemo(() => orderedMeters(result()?.snapshot?.meters ?? []))
  const options = createMemo(() => {
    if (!meters().length) {
      return [
        {
          title: usageStatus(result()),
          value: "__status__",
          description: result()?.error,
        },
      ]
    }
    return meters().map((meter) => ({
      title: meter.label,
      value: meter.id,
      details: [meterDetails(meter)],
    }))
  })
  const footer = createMemo(() => {
    if (refreshing()) return "◐ refreshing"
    const snapshot = result()?.snapshot
    if (!snapshot) return usageStatus(result())
    const scope = snapshot.scopeID ? `scope ${snapshot.scopeID}` : undefined
    return [usageStatus(result()), scope, `fetched ${formatTime(snapshot.fetchedAt)}`].filter(Boolean).join(" · ")
  })

  return (
    <DialogSelect
      title={`${props.providerName} usage`}
      options={options()}
      renderFilter={false}
      footer={<text>{footer()}</text>}
      actions={[
        {
          command: "model.dialog.usage.configure",
          title: "Configure footer",
          disabled: meters().length === 0,
          onTrigger: () =>
            dialog.replace(() => <DialogProviderUsage providerID={props.providerID} meters={meters()} />),
        },
        {
          command: "model.dialog.usage.refresh",
          title: "Refresh usage",
          disabled: refreshing(),
          onTrigger: refresh,
        },
      ]}
    />
  )
}

export type ProviderUsagePreferenceStore = {
  selected(providerID: string, available: string[]): string[]
  saved(providerID: string): string[] | undefined
  set(providerID: string, ids: string[]): void
}

export function DialogProviderUsage(props: { providerID: string; meters: Meter[] }) {
  const local = useLocal()
  return <DialogProviderUsagePreferences {...props} usage={local.model.usage} />
}

export function DialogProviderUsagePreferences(props: {
  providerID: string
  meters: Meter[]
  usage: ProviderUsagePreferenceStore
}) {
  const available = () => orderedMeters(props.meters).map((meter) => meter.id)
  const selected = () => props.usage.selected(props.providerID, available())
  const order = () => props.usage.saved(props.providerID) ?? available()
  const options = () =>
    props.meters
      .toSorted((a, b) => {
        const left = order().indexOf(a.id)
        const right = order().indexOf(b.id)
        if (left === -1 && right === -1) return a.order - b.order
        if (left === -1) return 1
        if (right === -1) return -1
        return left - right
      })
      .map((meter) => ({
        title: meter.label,
        value: meter.id,
        description: selected().includes(meter.id) ? "Shown" : "Hidden",
        onSelect: () => toggle(meter.id),
      }))

  function toggle(id: string) {
    const saved = props.usage.saved(props.providerID) ?? available()
    props.usage.set(props.providerID, saved.includes(id) ? saved.filter((item) => item !== id) : [...saved, id])
  }

  function move(id: string, direction: -1 | 1) {
    const saved = [...(props.usage.saved(props.providerID) ?? available())]
    const index = saved.indexOf(id)
    if (index === -1) return
    const next = Math.max(0, Math.min(saved.length - 1, index + direction))
    saved.splice(index, 1)
    saved.splice(next, 0, id)
    props.usage.set(props.providerID, saved)
  }

  return (
    <DialogSelect
      title="Footer usage"
      options={options()}
      actions={[
        { command: "usage.toggle", title: "Show / hide", onTrigger: (option) => toggle(option.value as string) },
        { command: "usage.move.up", title: "Move up", onTrigger: (option) => move(option.value as string, -1) },
        { command: "usage.move.down", title: "Move down", onTrigger: (option) => move(option.value as string, 1) },
      ]}
    />
  )
}

export function sortModelOptions<T extends { footer?: string; releaseDate: string | number; title: string }>(
  options: T[],
  newestFirst: boolean,
) {
  if (newestFirst) return sortBy(options, [(option) => option.releaseDate, "desc"], (option) => option.title)
  return sortBy(
    options,
    (option) => option.footer !== "Free",
    [(option) => option.releaseDate, "desc"],
    (option) => option.title,
  )
}
