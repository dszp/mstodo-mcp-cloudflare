import type { FeedStep, FeedTask } from "./feed";
import type { Mutation } from "./mutation";
import type { MirrorTask } from "./store";

// Optimistic edits: what a pending mutation looks like on screen before the
// server answers. The overlay only displays; the server decides the real
// values, and a pull replaces them (SYNC-API §5, §6).

export interface PendingContext {
  // The owner's today (loader.today(), the server's TIMEZONE), never the device date.
  today: string;
  // Where a task.create without a list_id goes.
  defaultListId: string;
}

export interface OverlayContext extends PendingContext {
  // The order value (task.create) or committed_order value (myday.add) that
  // puts this mutation's task first. The store supplies it, because only it
  // sees the other tasks; without it the value is TOP_SUFFIX alone.
  top?: (m: Mutation) => string;
}

// `order` and `committed_order` compare as text, descending (SYNC-API §4.10).
// A string followed by anything sorts after that string, so the current
// maximum plus one suffix sorts above every existing value, and plus k
// suffixes above k - 1 earlier pending ones. The value never leaves the
// client: the server picks the real order.
export const TOP_SUFFIX = "~";
export function above(max: string | null, k: number): string {
  return (max ?? "") + TOP_SUFFIX.repeat(Math.max(1, k));
}

// The task-level ops the overlay shows. task.reorder, myday.reorder,
// step.reorder and the link ops are left to the server's answer.
const TASK_OPS = new Set(["task.create", "task.update", "task.delete", "task.move", "myday.add", "myday.remove"]);
const STEP_OPS = new Set(["step.create", "step.update", "step.delete"]);

/** The task a mutation edits, when the overlay shows that op; else undefined. */
export function mutationTask(m: Mutation, stepParent: (stepSid: string) => string | undefined): string | undefined {
  if (TASK_OPS.has(m.op)) return m.sid;
  if (m.op === "step.create") return str(m.fields?.["task_id"]);
  if (STEP_OPS.has(m.op)) return stepParent(m.sid);
  return undefined;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const has = (f: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(f, k);

// The task.update fields of §5.2, copied as sent. A value of the wrong shape
// would be rejected by the server; showing it until then is harmless.
const TASK_FIELDS = [
  "title", "body", "status", "completed_at", "importance", "due", "start", "reminder", "categories", "recurrence",
] as const satisfies readonly (keyof FeedTask)[];

function withFields(t: MirrorTask, f: Record<string, unknown>, today: string): MirrorTask {
  const out: MirrorTask = { ...t };
  const target = out as unknown as Record<string, unknown>;
  for (const k of TASK_FIELDS) if (has(f, k)) target[k] = f[k];
  if (has(f, "status")) {
    // The app sends completion without completed_at; the server stamps the
    // owner's date (§6), which is today in the owner's zone.
    out.completed_at = f["status"] === "completed" ? (str(f["completed_at"]) ?? today) : null;
  }
  return out;
}

function newTask(m: Mutation, ctx: OverlayContext): MirrorTask {
  const f = m.fields ?? {};
  const blank: MirrorTask = {
    id: m.sid,
    list_id: str(f["list_id"]) ?? ctx.defaultListId,
    title: "",
    status: "notStarted",
    body: null,
    importance: "normal",
    categories: [],
    due: null,
    start: null,
    reminder: { on: false, at: null },
    completed_at: null,
    recurrence: null,
    created_at: m.at,
    modified_at: m.at,
    order: ctx.top?.(m) ?? above(null, 1),
    my_day: { committed_day: null, committed_order: null, postponed_day: null },
    subresources_complete: true,
    steps: [],
    links: [],
    attachments: [],
  };
  return withFields(blank, { status: "notStarted", ...f }, ctx.today);
}

function withStep(t: MirrorTask, m: Mutation): MirrorTask | undefined {
  const f = m.fields ?? {};
  if (m.op === "step.create") {
    // Already in the mirror: the server applied it and a pull brought it.
    if (t.id !== str(f["task_id"]) || t.steps.some((s) => s.id === m.sid)) return undefined;
    const checked = f["checked"] === true;
    const s: FeedStep = {
      id: m.sid,
      title: str(f["title"]) ?? null,
      checked,
      checked_at: checked ? m.at : null,
      created_at: m.at,
      order: null, // unordered steps show oldest first, so a new one is last
    };
    return { ...t, steps: [...t.steps, s] };
  }
  const i = t.steps.findIndex((s) => s.id === m.sid);
  if (i < 0) return undefined;
  if (m.op === "step.delete") return { ...t, steps: t.steps.filter((s) => s.id !== m.sid) };
  const old = t.steps[i]!;
  const s: FeedStep = { ...old };
  if (has(f, "title")) s.title = str(f["title"]) ?? null;
  if (has(f, "checked")) {
    s.checked = f["checked"] === true;
    s.checked_at = s.checked ? (old.checked_at ?? m.at) : null;
  }
  const steps = [...t.steps];
  steps[i] = s;
  return { ...t, steps };
}

/**
 * One pending mutation applied to the task it edits. Returns the new task,
 * null when the mutation deletes it, and undefined when the mutation isn't
 * this task's (or is an op the overlay doesn't show), so the caller keeps
 * what it had. `base` is undefined for a task the mirror doesn't hold; only
 * a task.create makes one. Pure: `base` is never changed.
 */
export function applyOptimistic(
  base: MirrorTask | undefined,
  m: Mutation,
  ctx: OverlayContext,
): MirrorTask | null | undefined {
  if (STEP_OPS.has(m.op)) return base === undefined ? undefined : withStep(base, m);
  if (!TASK_OPS.has(m.op)) return undefined;
  if (base === undefined) return m.op === "task.create" ? newTask(m, ctx) : undefined;
  if (base.id !== m.sid) return undefined;
  const f = m.fields ?? {};
  switch (m.op) {
    case "task.create":
      return undefined; // already in the mirror: the server's copy wins
    case "task.update":
      return withFields(base, f, ctx.today);
    case "task.delete":
      return null;
    case "task.move": {
      const listId = str(f["list_id"]);
      return listId === undefined ? undefined : { ...base, list_id: listId };
    }
    case "myday.add":
      return {
        ...base,
        my_day: { ...base.my_day, committed_day: ctx.today, committed_order: ctx.top?.(m) ?? above(null, 1) },
      };
    case "myday.remove":
      return { ...base, my_day: { ...base.my_day, committed_day: null } };
    default:
      return undefined;
  }
}
