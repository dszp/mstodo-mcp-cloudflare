import { useSyncExternalStore } from "react";
import type { MirrorStore, StoreKey } from "../src/sync/store";

// Re-renders when the key's version changes; returns the version, which callers
// ignore except as a render trigger (they read the data from the store).
export function useStoreKey(store: MirrorStore, key: StoreKey): number {
  const k = typeof key === "string" ? key : key.task;
  // key identity can change per render ({ task: id } is a fresh object), so the
  // subscribe callback is keyed on its string form.
  return useSyncExternalStore(
    (cb) => store.subscribe(typeof key === "string" ? key : { task: k }, cb),
    () => store.version(typeof key === "string" ? key : { task: k }),
  );
}
