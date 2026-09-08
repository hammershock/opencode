import {
  createContext,
  createMemo,
  createSignal,
  useContext,
  type Accessor,
  type ParentProps,
  type Setter,
} from "solid-js"
import { useSync } from "../../context/sync"
import { useTuiPaths } from "../../context/runtime"
import { LocationProvider } from "../../context/location"

export type HomeSessionTarget = { type: "local" } | { type: "rexd"; targetID: string; name: string }
export type HomeSessionDestination = { type: "directory"; directory: string; subdirectory: boolean } | { type: "new" }

type Context = {
  destination: Accessor<HomeSessionDestination | undefined>
  setDestination: Setter<HomeSessionDestination | undefined>
  target: Accessor<HomeSessionTarget>
  setTarget: Setter<HomeSessionTarget>
  clear: () => void
}

const HomeSessionDestinationContext = createContext<Context>()

export function HomeSessionDestinationProvider(props: ParentProps) {
  const sync = useSync()
  const paths = useTuiPaths()
  const [selected, setDestination] = createSignal<HomeSessionDestination>()
  const [target, setTarget] = createSignal<HomeSessionTarget>({ type: "local" })
  const destination = createMemo<HomeSessionDestination>(
    () => selected() ?? { type: "directory", directory: sync.path.directory || paths.cwd, subdirectory: false },
  )
  const location = createMemo(() => {
    const current = destination()
    if (current.type !== "directory") return
    const currentTarget = target()
    return {
      target:
        currentTarget.type === "rexd"
          ? ({ type: "rexd", targetID: currentTarget.targetID } as const)
          : ({ type: "local" } as const),
      directory: current.directory,
    }
  })
  return (
    <HomeSessionDestinationContext.Provider
      value={{
        destination,
        setDestination,
        target,
        setTarget,
        clear: () => {
          setDestination(undefined)
          setTarget({ type: "local" })
        },
      }}
    >
      <LocationProvider location={location()}>{props.children}</LocationProvider>
    </HomeSessionDestinationContext.Provider>
  )
}

export function useHomeSessionDestination() {
  return useContext(HomeSessionDestinationContext)
}
