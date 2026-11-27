import type { SmartList } from "./feed";
import type { MirrorStore, MirrorTask } from "./store";

// Smart lists and local search, per docs/SYNC-API.md section 4.10. Pure over the
// store: "today" is passed in, never read from a clock.

export interface SmartOpts {
  today: string;
  dueTodayInMyDay?: boolean;
  completedSince?: string;
}

export type SearchScope =
  | { listId: string }
  | { smart: SmartList; today: string; dueTodayInMyDay?: boolean };

export interface SearchOpts {
  scope?: SearchScope;
  includeCompleted?: boolean; // default true
  completedSince?: string;
}

type Key = readonly [get: (t: MirrorTask) => string | null, dir: "asc" | "desc"];

// The one comparator behind every ordering. Strings compare as text (UTF-16
// code units, independent of locale). A null sorts last when descending and
// first when ascending, as in SQLite. Rows still tied sort by id ascending.
function comparator(...keys: Key[]): (a: MirrorTask, b: MirrorTask) => number {
  return (a, b) => {
    for (const [get, dir] of keys) {
      const x = get(a);
      const y = get(b);
      if (x === y) continue;
      const nullFirst = dir === "asc";
      if (x === null) return nullFirst ? -1 : 1;
      if (y === null) return nullFirst ? 1 : -1;
      const c = x < y ? -1 : 1;
      return dir === "asc" ? c : -c;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

const byOrder: Key = [(t) => t.order, "desc"];
const byCreated: Key = [(t) => t.created_at, "desc"];
const byCompleted: Key = [(t) => t.completed_at, "desc"];
const byModified: Key = [(t) => t.modified_at, "desc"];

const SORTS: Record<SmartList, (a: MirrorTask, b: MirrorTask) => number> = {
  my_day: comparator([(t) => t.my_day.committed_order, "desc"], byOrder),
  important: comparator(byOrder, byCreated),
  planned: comparator([(t) => t.due, "asc"], byOrder),
  all: comparator(byOrder, byCreated),
  completed: comparator(byCompleted, byModified),
};

const isOpen = (t: MirrorTask) => t.status !== "completed";

// A task whose list has not arrived yet counts as being in a non-reference
// list, so it is included until the list says otherwise.
function inReferenceList(store: MirrorStore, t: MirrorTask): boolean {
  return t.list_id !== null && store.list(t.list_id)?.sync === "reference";
}

// A smart list's "Holds" rule. `requireOpen` is the list's own open
// requirement: search drops it (only "Include Completed" decides there), but
// My Day's due-today branch is open-only either way.
function holds(list: SmartList, t: MirrorTask, o: Omit<SmartOpts, "completedSince">, requireOpen: boolean): boolean {
  const open = !requireOpen || isOpen(t);
  switch (list) {
    case "my_day":
      return t.my_day.committed_day === o.today || (o.dueTodayInMyDay === true && isOpen(t) && t.due === o.today);
    case "important":
      return open && t.importance === "high";
    case "planned":
      return open && t.due !== null;
    case "all":
      return open;
    case "completed":
      return !isOpen(t);
  }
}

// "completed since" drops a completed task completed before the date, and one
// with no completed_at. Open tasks are unaffected.
function passesSince(t: MirrorTask, since: string | undefined): boolean {
  if (since === undefined || isOpen(t)) return true;
  return t.completed_at !== null && t.completed_at >= since;
}

export function smartListTasks(store: MirrorStore, list: SmartList, opts: SmartOpts): MirrorTask[] {
  return store
    .tasks()
    .filter(
      (t) =>
        !inReferenceList(store, t) &&
        holds(list, t, opts, true) &&
        (list !== "completed" || passesSince(t, opts.completedSince)),
    )
    .sort(SORTS[list]);
}

// Open tasks in the list; for `completed`, the completed tasks. My Day's count
// is its open tasks too, even though the list also shows completed ones.
export function smartCounts(store: MirrorStore, opts: SmartOpts): Record<SmartList, number> {
  const count = (list: SmartList): number => {
    const held = smartListTasks(store, list, opts);
    return list === "completed" ? held.length : held.filter(isOpen).length;
  };
  return {
    my_day: count("my_day"),
    important: count("important"),
    planned: count("planned"),
    all: count("all"),
    completed: count("completed"),
  };
}

// Web-only: one list's tasks, open by order desc, then completed by
// completed_at desc, modified_at desc.
export function listTasks(store: MirrorStore, listId: string): MirrorTask[] {
  const inList = store.tasks().filter((t) => t.list_id === listId);
  return [
    ...inList.filter(isOpen).sort(comparator(byOrder)),
    ...inList.filter((t) => !isOpen(t)).sort(comparator(byCompleted, byModified)),
  ];
}

// Case folding for ASCII letters only, as SQLite's LIKE does, so every client
// agrees on every query. Other characters compare exactly.
const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

export function searchLocal(store: MirrorStore, text: string, opts: SearchOpts = {}): MirrorTask[] {
  const words = fold(text).split(/\s+/).filter((w) => w !== "");
  if (words.length === 0) return []; // an empty query matches nothing
  const includeCompleted = opts.includeCompleted ?? true;
  const scope = opts.scope;

  const inScope = (t: MirrorTask): boolean => {
    if (scope === undefined) return true;
    if ("listId" in scope) return t.list_id === scope.listId;
    return !inReferenceList(store, t) && holds(scope.smart, t, scope, false);
  };
  const matches = (t: MirrorTask): boolean => {
    const fields = [t.title, t.body?.content ?? "", ...t.steps.map((s) => s.title ?? "")].map(fold);
    return words.every((w) => fields.some((f) => f.includes(w)));
  };

  // Group 0: open, title has the first word; 1: open; 2: completed, title has
  // it; 3: completed.
  const group = (t: MirrorTask): number => (isOpen(t) ? 0 : 2) + (fold(t.title).includes(words[0]!) ? 0 : 1);
  const within = comparator(byOrder);
  return store
    .tasks()
    .filter(
      (t) => inScope(t) && (includeCompleted || isOpen(t)) && passesSince(t, opts.completedSince) && matches(t),
    )
    .sort((a, b) => group(a) - group(b) || within(a, b));
}
