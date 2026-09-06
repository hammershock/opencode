import { createEffect, createMemo, createSignal } from "solid-js"
import { useLocal } from "../context/local"
import { map, pipe, flatMap, entries, filter, sortBy, take } from "remeda"
import { DialogSelect } from "../ui/dialog-select"
import { useDialog } from "../ui/dialog"
import { createDialogProviderOptions, DialogProvider } from "./dialog-provider"
import { DialogVariant } from "./dialog-variant"
import * as fuzzysort from "fuzzysort"
import { useConnected } from "./use-connected"
import { useSync } from "../context/sync"
import { load, summary, type Meter, type Result } from "../provider-usage"
import { useSDK } from "../context/sdk"

export function DialogModel(props: { providerID?: string }) {
  const local = useLocal()
  const sync = useSync()
  const dialog = useDialog()
  const sdk = useSDK()
  const [query, setQuery] = createSignal("")
  const [usage, setUsage] = createSignal<Record<string, Result>>({})

  createEffect(() => {
    for (const provider of sync.data.provider) {
      if (usage()[provider.id]) continue
      void load(sdk, provider.id).then((result) => setUsage((current) => ({ ...current, [provider.id]: result })))
    }
  })

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
            footer: model.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined,
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
            footer:
              summary(
                usage()[provider.id],
                local.model.usage.selected(
                  provider.id,
                  usage()[provider.id]?.snapshot?.meters.map((meter) => meter.id) ?? [],
                ),
              ) ?? (info.cost?.input === 0 && provider.id === "opencode" ? "Free" : undefined),
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
          command: "model.dialog.usage.configure",
          title: "Configure footer usage",
          hidden: !connected(),
          onTrigger: (option) => {
            const providerID = (option.value as { providerID: string }).providerID
            const meters = usage()[providerID]?.snapshot?.meters
            if (!meters?.length) return
            dialog.replace(() => <DialogProviderUsage providerID={providerID} meters={meters} />)
          },
        },
        {
          command: "model.dialog.usage.refresh",
          title: "Refresh provider usage",
          hidden: !connected(),
          onTrigger: (option) => {
            const providerID = (option.value as { providerID: string }).providerID
            void load(sdk, providerID, true).then((result) =>
              setUsage((current) => ({ ...current, [providerID]: result })),
            )
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

function DialogProviderUsage(props: { providerID: string; meters: Meter[] }) {
  const local = useLocal()
  const available = () => props.meters.map((meter) => meter.id)
  const selected = () => local.model.usage.selected(props.providerID, available())
  const order = () => local.model.usage.saved(props.providerID) ?? available()
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
    const saved = local.model.usage.saved(props.providerID) ?? available()
    local.model.usage.set(props.providerID, saved.includes(id) ? saved.filter((item) => item !== id) : [...saved, id])
  }

  function move(id: string, direction: -1 | 1) {
    const saved = [...(local.model.usage.saved(props.providerID) ?? available())]
    const index = saved.indexOf(id)
    if (index === -1) return
    const next = Math.max(0, Math.min(saved.length - 1, index + direction))
    saved.splice(index, 1)
    saved.splice(next, 0, id)
    local.model.usage.set(props.providerID, saved)
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
