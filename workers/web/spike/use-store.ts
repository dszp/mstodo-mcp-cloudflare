import { useCallback, useSyncExternalStore } from "react";
import type { MirrorStore, StoreKey } from "../src/sync/store";

// Re-renders when the key's version changes; returns the version, which callers
// ignore except as a render trigger (they read the data from the store).
// The key is reduced to a string so subscribe/getSnapshot keep their identity
// across renders; fresh functions would make useSyncExternalStore resubscribe.
export function useStoreKey(store: MirrorStore, key: StoreKey): number {
  const task = typeof key === "string" ? null : key.task;
  const name = typeof key === "string" ? key : null;
  const k = useCallback((): StoreKey => (task !== null ? { task } : (name as StoreKey)), [task, name]);
  const subscribe = useCallback((cb: () => void) => store.subscribe(k(), cb), [store, k]);
  const snapshot = useCallback(() => store.version(k()), [store, k]);
  return useSyncExternalStore(subscribe, snapshot);
}
