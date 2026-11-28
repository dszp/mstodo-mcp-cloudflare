import type { FeedChange, FeedList, FeedListGroup, FeedTask } from "./feed";
import type { Mutation } from "./mutation";
import { above, applyOptimistic, mutationTask, type PendingContext } from "./overlay";

// Entities keep their id beside the feed's data; the feed's `data` has none.
export type MirrorTask = FeedTask & { id: string };
export type MirrorList = FeedList & { id: string };
export type MirrorGroup = FeedListGroup & { id: string };

// "lists" covers both lists and list groups (the sidebar reads them together).
export type StoreKey = { task: string } | "tasks" | "lists";

// In-memory mirror of the feed, read by the UI through useSyncExternalStore.
// A page applies as one batch and notifies each affected key once, after the
// whole page is in, so a 500-change page is one render pass.
//
// Pending edits lie over the mirror: task() and tasks() return each task with
// the outbox's mutations applied in queue order (overlay.ts), so every view,
// smart list and search shows an edit at once. baseTask() and baseTasks() are
// the server's state. The overlay is cached per task and recomputed only for
// the tasks whose edits or base changed.
export class MirrorStore {
  #tasks = new Map<string, MirrorTask>();
  #lists = new Map<string, MirrorList>();
  #groups = new Map<string, MirrorGroup>();
  #baseArr: readonly MirrorTask[] | null = null;
  #taskArr: readonly MirrorTask[] | null = null;
  #listArr: readonly MirrorList[] | null = null;
  #groupArr: readonly MirrorGroup[] | null = null;
  #versions = new Map<string, number>();
  #subs = new Map<string, Set<() => void>>();
  #sealed = false;
  // The outbox's queue, as last given to setPending.
  #pending: readonly Mutation[] = [];
  #ctx: PendingContext | null = null;
  // Each edited task's mutations, in queue order.
  #edits = new Map<string, readonly Mutation[]>();
  // The overlaid task for each sid whose edits change it; null when an edit
  // deletes it. A sid not here shows its base.
  #view = new Map<string, MirrorTask | null>();
  // Step sid -> task sid over the base tasks, built when a step edit needs it.
  #stepIndex: Map<string, string> | null = null;

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
    const taskSids = new Set<string>();
    for (const c of changes) {
      switch (c.kind) {
        case "task":
          if (c.deleted ? this.#tasks.delete(c.id) : (this.#tasks.set(c.id, { id: c.id, ...c.data }), true)) {
            this.#baseArr = this.#taskArr = this.#stepIndex = null;
            taskSids.add(c.id);
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
    // A changed base shows through, or under the edits still pending for it.
    if (taskSids.size > 0 && this.#pending.length > 0) for (const k of this.#refresh(taskSids, false)) dirty.add(k);
    this.#notify(dirty);
    return true;
  }

  /**
   * The outbox's pending mutations, in queue order. The app calls it on every
   * outbox change and when `today` changes. A mutation no longer in the list
   * stops applying (it was answered, or rejected), so the base shows through.
   * Ignored once sealed.
   */
  setPending(mutations: readonly Mutation[], ctx: PendingContext): void {
    if (this.#sealed) return;
    const old = this.#ctx;
    const ctxChanged = old === null || old.today !== ctx.today || old.defaultListId !== ctx.defaultListId;
    this.#pending = mutations;
    this.#ctx = { today: ctx.today, defaultListId: ctx.defaultListId };
    this.#notify(this.#refresh(new Set(), ctxChanged));
  }

  /**
   * Refuses every later page; clear() still works. The page seals the store
   * when the session ends, so a response that lands afterwards can't refill
   * it. There is no unseal: signing in again is a navigation to /auth/login,
   * which loads a fresh page with a fresh store.
   */
  seal(): void {
    this.#sealed = true;
    this.#notify(this.#dropOverlay());
  }

  clear(): void {
    const dirty = this.#dropOverlay();
    dirty.add("tasks").add("lists");
    for (const id of this.#tasks.keys()) dirty.add(MirrorStore.#k({ task: id }));
    this.#tasks.clear();
    this.#lists.clear();
    this.#groups.clear();
    this.#baseArr = this.#taskArr = this.#listArr = this.#groupArr = this.#stepIndex = null;
    this.#notify(dirty);
  }

  /** The task with its pending edits; undefined when absent or pending deletion. */
  task(id: string): MirrorTask | undefined {
    if (this.#view.has(id)) return this.#view.get(id) ?? undefined;
    return this.#tasks.get(id);
  }
  /** The task as the server last sent it. */
  baseTask(id: string): MirrorTask | undefined {
    return this.#tasks.get(id);
  }
  list(id: string): MirrorList | undefined {
    return this.#lists.get(id);
  }
  /** Every task with its pending edits: pending creates in, pending deletes out. */
  tasks(): readonly MirrorTask[] {
    return (this.#taskArr ??= this.#view.size === 0 ? this.baseTasks() : this.#overlaid());
  }
  baseTasks(): readonly MirrorTask[] {
    return (this.#baseArr ??= [...this.#tasks.values()]);
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

  #overlaid(): MirrorTask[] {
    const out: MirrorTask[] = [];
    for (const [id, t] of this.#tasks) {
      const v = this.#view.has(id) ? this.#view.get(id) : t;
      if (v) out.push(v);
    }
    for (const [id, v] of this.#view) if (v && !this.#tasks.has(id)) out.push(v);
    return out;
  }

  // Forgets every pending edit; returns the keys of the tasks that showed one.
  #dropOverlay(): Set<string> {
    const dirty = new Set<string>();
    for (const id of this.#view.keys()) dirty.add(MirrorStore.#k({ task: id }));
    if (dirty.size > 0) dirty.add("tasks");
    this.#pending = [];
    this.#edits = new Map();
    this.#view.clear();
    this.#taskArr = null;
    return dirty;
  }

  #stepParent(stepSid: string): string | undefined {
    if (this.#stepIndex === null) {
      this.#stepIndex = new Map();
      for (const t of this.#tasks.values()) for (const s of t.steps) this.#stepIndex.set(s.id, t.id);
    }
    return this.#stepIndex.get(stepSid);
  }

  // Groups the queue by the task each mutation edits. A step created by an
  // earlier pending mutation is found through that mutation's task_id.
  #group(): Map<string, Mutation[]> {
    const byTask = new Map<string, Mutation[]>();
    const createdSteps = new Map<string, string>();
    for (const m of this.#pending) {
      const sid = mutationTask(m, (s) => createdSteps.get(s) ?? this.#stepParent(s));
      if (sid === undefined) continue;
      if (m.op === "step.create") createdSteps.set(m.sid, sid);
      const list = byTask.get(sid);
      if (list) list.push(m);
      else byTask.set(sid, [m]);
    }
    return byTask;
  }

  // The "top" value of each pending task.create (order, within its list) and
  // myday.add (committed_order, within today's My Day): above the base
  // maximum, and each later one above the earlier ones (overlay.ts `above`).
  // Measured against base tasks only: a task moved in by a pending task.move
  // with a higher order can still sort above a pending create.
  #tops(ctx: PendingContext): Map<string, string> {
    const tops = new Map<string, string>();
    const creates = this.#pending.filter((m) => m.op === "task.create");
    const adds = this.#pending.filter((m) => m.op === "myday.add");
    if (creates.length === 0 && adds.length === 0) return tops;
    const listOf = (m: Mutation) => {
      const v = m.fields?.["list_id"];
      return typeof v === "string" ? v : ctx.defaultListId;
    };
    const lists = new Set(creates.map(listOf));
    const maxOrder = new Map<string, string | null>();
    let maxCommitted: string | null = null;
    const gt = (a: string | null, b: string | null) => a !== null && (b === null || a > b);
    for (const t of this.#tasks.values()) {
      if (t.list_id !== null && lists.has(t.list_id) && gt(t.order, maxOrder.get(t.list_id) ?? null)) {
        maxOrder.set(t.list_id, t.order);
      }
      if (t.my_day.committed_day === ctx.today && gt(t.my_day.committed_order, maxCommitted)) {
        maxCommitted = t.my_day.committed_order;
      }
    }
    const seen = new Map<string, number>();
    for (const m of creates) {
      const l = listOf(m);
      const k = (seen.get(l) ?? 0) + 1;
      seen.set(l, k);
      tops.set(m.id, above(maxOrder.get(l) ?? null, k));
    }
    adds.forEach((m, i) => tops.set(m.id, above(maxCommitted, i + 1)));
    return tops;
  }

  // Recomputes the overlaid tasks whose edits changed, whose base changed
  // (baseDirty), that depend on a "top" value, or all of them when the
  // context changed. Returns the keys to notify: a task's key only when what
  // it shows changed, and "tasks" with any of them.
  #refresh(baseDirty: ReadonlySet<string>, ctxChanged: boolean): Set<string> {
    const dirty = new Set<string>();
    const ctx = this.#ctx;
    if (ctx === null) return dirty;
    const old = this.#edits;
    const next = this.#group();
    this.#edits = next;
    const tops = this.#tops(ctx);
    const overlayCtx = { ...ctx, top: (m: Mutation) => tops.get(m.id) ?? above(null, 1) };

    const candidates = new Set<string>();
    for (const sid of old.keys()) if (!next.has(sid)) candidates.add(sid);
    for (const [sid, ms] of next) {
      const prev = old.get(sid);
      const same = prev !== undefined && prev.length === ms.length && prev.every((m, i) => m === ms[i]);
      if (!same || ctxChanged || baseDirty.has(sid) || ms.some((m) => tops.has(m.id))) candidates.add(sid);
    }

    for (const sid of candidates) {
      const base = this.#tasks.get(sid);
      const had = this.#view.has(sid);
      const before = had ? (this.#view.get(sid) ?? undefined) : base;
      let shown: MirrorTask | null | undefined = base;
      for (const m of next.get(sid) ?? []) {
        if (shown === null) break;
        const r = applyOptimistic(shown, m, overlayCtx);
        if (r !== undefined) shown = r;
      }
      const after = shown ?? undefined;
      if (shown === base) this.#view.delete(sid);
      else if (had && JSON.stringify(after) === JSON.stringify(before)) continue; // same content: keep the object
      else this.#view.set(sid, shown ?? null);
      if (after !== before || baseDirty.has(sid)) {
        dirty.add(MirrorStore.#k({ task: sid })).add("tasks");
        this.#taskArr = null;
      }
    }
    return dirty;
  }

  #notify(dirty: ReadonlySet<string>): void {
    for (const k of dirty) this.#versions.set(k, (this.#versions.get(k) ?? 0) + 1);
    for (const k of dirty) for (const cb of [...(this.#subs.get(k) ?? [])]) cb();
  }
}
