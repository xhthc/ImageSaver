import { useSyncExternalStore } from "react"

type Store<T> = { getState: () => T; subscribe: (fn: () => void) => () => void }

/** Subscribes a component to a controller store (see src/core/store.js). */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.getState, store.getState)
}
