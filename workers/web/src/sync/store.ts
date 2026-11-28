import type { FeedChange, FeedList, FeedListGroup, FeedTask } from "./feed";

// Entities keep their id beside the feed's data; the feed's `data` has none.
export type MirrorTask = FeedTask & { id: string };
export type MirrorList = FeedList & { id: string };
export type MirrorGroup = FeedListGroup & { id: string };

// "lists" covers both lists and list groups (the sidebar reads them together).
export type StoreKey = { task: string } | "tasks" | "lists";

// In-memory mirror of the feed, read by the UI through useSyncExternalStore.
// A page applies as one batch and notifies each affected key once, after the
// whole page is in, so a 500-change page is one render pass.
export class MirrorStore {
  #tasks = new Map<string, MirrorTask>();
  #lists = new Map<string, MirrorList>();
  #groups = new Map<string, MirrorGroup>();
  #taskArr: readonly MirrorTask[] | null = null;
  #listArr: readonly MirrorList[] | null = null;
  #groupArr: readonly MirrorGroup[] | null = null;
  #versions = new Map<string, number>();
  #subs = new Map<string, Set<() => void>>();
  #sealed = false;

  static #k(key: StoreKey): string {
    return typeof key === "string" ? key : `task:${key.task}`;
  }

  /**
   * Applies one page. Returns false, changing nothing, once the store is
   * sealed: a page still in flight when the session ended is dropped quietly
   * rather than thrown, because whoever sealed the store has already shown
   * the signed-out state and the page's caller has nothing useful to do.
   */
  applyPage(changes: readonly FeedChange[]): boolean {
    if (this.#sealed) return false;
    const dirty = new Set<string>();
    for (const c of changes) {
      switch (c.kind) {
        case "task":
          if (c.deleted ? this.#tasks.delete(c.id) : (this.#tasks.set(c.id, { id: c.id, ...c.data }), true)) {
            this.#taskArr = null;
            dirty.add("tasks").add(MirrorStore.#k({ task: c.id }));
          }
          break;
        case "list":
          if (c.deleted ? this.#lists.delete(c.id) : (this.#lists.set(c.id, { id: c.id, ...c.data }), true)) {
            this.#listArr = null;
            dirty.add("lists");
          }
          break;
        case "list_group":
          if (c.deleted ? this.#groups.delete(c.id) : (this.#groups.set(c.id, { id: c.id, ...c.data }), true)) {
            this.#groupArr = null;
            dirty.add("lists");
          }
          break;
        // theme_image and app_settings are accepted and ignored: the spike UI
        // doesn't render them yet, so they neither change state nor notify.
        default:
          break;
      }
    }
    this.#notify(dirty);
    return true;
  }

  /**
   * Refuses every later page; clear() still works. The page seals the store
   * when the session ends, so a response that lands afterwards can't refill
   * it. There is no unseal: signing in again is a navigation to /auth/login,
   * which loads a fresh page with a fresh store.
   */
  seal(): void {
    this.#sealed = true;
  }

  clear(): void {
    const dirty = new Set<string>(["tasks", "lists"]);
    for (const id of this.#tasks.keys()) dirty.add(MirrorStore.#k({ task: id }));
    this.#tasks.clear();
    this.#lists.clear();
    this.#groups.clear();
    this.#taskArr = this.#listArr = this.#groupArr = null;
    this.#notify(dirty);
  }

  task(id: string): MirrorTask | undefined {
    return this.#tasks.get(id);
  }
  list(id: string): MirrorList | undefined {
    return this.#lists.get(id);
  }
  tasks(): readonly MirrorTask[] {
    return (this.#taskArr ??= [...this.#tasks.values()]);
  }
  lists(): readonly MirrorList[] {
    return (this.#listArr ??= [...this.#lists.values()]);
  }
  groups(): readonly MirrorGroup[] {
    return (this.#groupArr ??= [...this.#groups.values()]);
  }

  subscribe(key: StoreKey, cb: () => void): () => void {
    const k = MirrorStore.#k(key);
    let set = this.#subs.get(k);
    if (!set) this.#subs.set(k, (set = new Set()));
    set.add(cb);
    return () => {
      set.delete(cb);
      if (set.size === 0 && this.#subs.get(k) === set) this.#subs.delete(k);
    };
  }

  version(key: StoreKey): number {
    return this.#versions.get(MirrorStore.#k(key)) ?? 0;
  }

  #notify(dirty: ReadonlySet<string>): void {
    for (const k of dirty) this.#versions.set(k, (this.#versions.get(k) ?? 0) + 1);
    for (const k of dirty) for (const cb of [...(this.#subs.get(k) ?? [])]) cb();
  }
}
