// The sync mutation executor (docs/SYNC-API.md section 5.2): one mutation,
// already resolved to Graph IDs by applyBatch, run through the same ops the
// MCP tools use. This module owns two translations and nothing else:
//
//   - the sync API's field names and shapes → the ops' inputs, and
//   - the ops' outcomes and thrown errors → ExecOutcome (applied, rejected for
//     good, or failed with a retry hint).
//
// Every op runs in ctx.writes; the route hands in the queue of the one lease
// it holds for the whole batch.
import { log } from "../log";
import { myDayEnabled } from "../auth/microsoft";
import { isReauthRequired } from "../auth/reauth";
import { GraphError } from "../graph/client";
import { SubstrateError } from "../graph/substrate-client";
import { bestEffort, type OpsContext } from "../ops/context";
import { createLink, deleteLink, updateLink } from "../ops/links";
import { createList, deleteList, updateList } from "../ops/lists";
import { addToMyDay, removeFromMyDay, reorderMyDayTask } from "../ops/my-day";
import type { ReorderPosition } from "../ops/position";
import type { ToolResult } from "../ops/result";
import { createStep, deleteStep, reorderStep, updateStep } from "../ops/steps";
import { createTask, deleteTask, moveTask, reorderTask, updateTask, type UpdateTaskInput } from "../ops/tasks";
import { WriteBusyError } from "../ops/write-lease";
import { normalizeSid, type ExecInput, type ExecOutcome, type Executor, type Position } from "./mutations";

// Graph requires an application name on a linked resource; the sync API has
// no field for it, so links the app creates carry this one.
export const SYNC_LINK_APPLICATION = "Microsoft To Do sync";

const IMPORTANCE = ["low", "normal", "high"] as const;
const STATUS = ["notStarted", "inProgress", "completed", "waitingOnOthers", "deferred"] as const;
const BARE_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Ops that need Substrate, which is reachable only with My Day on.
const NEEDS_MY_DAY = new Set(["task.reorder", "myday.add", "myday.remove", "myday.reorder", "step.reorder"]);

const applied = (graphId: string): ExecOutcome => ({ ok: true, graphId });
const rejected = (error: string): ExecOutcome => ({ ok: false, error, retry: false, rejected: true });
const retryable = (error: string): ExecOutcome => ({ ok: false, error, retry: true });

class Invalid extends Error {}
const invalid = (field: string): never => {
  throw new Invalid(`invalid_field:${field}`);
};

export function syncExecutor(ctx: OpsContext): Executor {
  return async (input) => {
    try {
      return await execute(ctx, input);
    } catch (e) {
      if (e instanceof Invalid) return rejected(e.message);
      return outcomeOfThrown(ctx, input, e);
    }
  };
}

// What a throw from an op means for the app (section 5.3). An op returns
// err() for its own deterministic refusals; what propagates is transport,
// throttling, auth and the write queue.
async function outcomeOfThrown(ctx: OpsContext, input: ExecInput, e: unknown): Promise<ExecOutcome> {
  // No stored Microsoft tokens at all is the same state for the app: the
  // owner has to sign in before anything syncs.
  if (isReauthRequired(e) || (e instanceof Error && e.message === "not_authenticated")) return retryable("reauth_required");
  if (e instanceof WriteBusyError) return retryable("write_busy");
  if (e instanceof GraphError) {
    if (e.status === 429 || e.status >= 500) return retryable(`graph_${e.status}`);
    return rejected(`graph_${e.status}`);
  }
  // The index throws a plain Error("my_day_unavailable") (flattened over DO
  // RPC) when the Exchange Online scope isn't consented. Not `rejected`: a
  // rejected result is stored for good, and this one clears once the owner
  // re-authorizes.
  if (e instanceof Error && e.message.includes("my_day_unavailable")) return { ok: false, error: "my_day_unavailable", retry: false };
  if (e instanceof SubstrateError) {
    if (e.status === 429 || e.status >= 500) return retryable(`substrate_${e.status}`);
    if (e.status === 403) {
      // Same latch as the MCP tools: stop trying Substrate until re-consent.
      await bestEffort("mark_my_day_unavailable_failed", {}, () => ctx.index.markMyDayUnavailable());
      return { ok: false, error: "my_day_unavailable", retry: false };
    }
    return rejected(`substrate_${e.status}`);
  }
  // fetch() rejects with a TypeError when the network fails.
  if (e instanceof TypeError) return retryable("network_error");
  log.error("sync_mutation_failed", { op: input.op, error: e instanceof Error ? e.message : String(e) });
  return { ok: false, error: "internal_error", retry: false };
}

async function execute(ctx: OpsContext, input: ExecInput): Promise<ExecOutcome> {
  const { op, fields } = input;
  if (NEEDS_MY_DAY.has(op) || (op === "task.move" && input.position)) {
    if (!myDayEnabled(ctx.env)) return rejected("my_day_disabled");
  }
  const graphId = input.graphId ?? "";
  const ref = (key: "list_id" | "task_id"): string => {
    const sid = fields[key];
    if (typeof sid !== "string") return invalid(key);
    // applyBatch resolved every sid in fields before calling.
    return input.ids[normalizeSid(sid)];
  };

  switch (op) {
    case "list.create": {
      const r = await createList(ctx, { display_name: requiredText(fields, "name") });
      return r.ok ? applied(r.value.list.id) : rejected(r.reason);
    }
    case "list.update": {
      const r = await updateList(ctx, { list_id: graphId, display_name: requiredText(fields, "name") });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }
    case "list.delete": {
      const r = await deleteList(ctx, { list_id: graphId });
      if (!r.ok && r.reason === "list_not_found") {
        await bestEffort("index_delete_list_failed", { list_id: graphId }, () => ctx.index.deleteList(graphId));
      }
      return deleted(r, graphId, "list_not_found");
    }

    case "task.create": {
      const list_id = ref("list_id");
      const t = taskFields(fields);
      const r = await createTask(ctx, { list_id, title: requiredText(fields, "title"), ...createFields(t) });
      if (!r.ok) return rejected(r.reason);
      const taskId = r.value.task.id;
      // Graph's create takes no completion date; set it with a second write.
      // The task exists either way, so a failure here doesn't fail the create.
      const completed_date = t.completed_date;
      if (completed_date) {
        await afterCommit("sync_create_completed_date_failed", taskId, () =>
          updateTask(ctx, { list_id, task_id: taskId, completed_date }),
        );
      }
      return applied(taskId);
    }
    case "task.update": {
      const list_id = await listOfTask(ctx, graphId);
      if (!list_id) return rejected("unknown_task");
      const r = await updateTask(ctx, { list_id, task_id: graphId, ...taskFields(fields) });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }
    case "task.delete": {
      const list_id = await listOfTask(ctx, graphId);
      if (!list_id) return rejected("unknown_task");
      const r = await deleteTask(ctx, { list_id, task_id: graphId });
      if (!r.ok && r.reason === "task_not_found") {
        await bestEffort("index_delete_task_failed", { task_id: graphId }, () => ctx.index.deleteTask(graphId));
      }
      return deleted(r, graphId, "task_not_found");
    }
    case "task.move": {
      const to_list_id = ref("list_id");
      const from_list_id = await listOfTask(ctx, graphId);
      if (!from_list_id) return rejected("unknown_task");
      let taskId = graphId;
      if (from_list_id !== to_list_id) {
        const r = await moveTask(ctx, { task_id: graphId, from_list_id, to_list_id });
        if (!r.ok) return rejected(r.reason);
        // An aborted copy-and-delete left the source untouched; what stopped
        // it (an attachment too large to copy, …) will stop a retry too.
        if (r.value.status === "aborted") return { ok: false, error: `move_aborted:${r.value.error}`, retry: false };
        taskId = r.value.task_id;
      }
      if (input.position) {
        // The move has committed; a failed reorder can't undo it.
        const pos = reorderPosition(input.position, input.ids);
        const moved = taskId;
        await afterCommit("sync_move_reorder_failed", moved, () =>
          reorderTask(ctx, { list_id: to_list_id, task_id: moved, position: pos }),
        );
      }
      return applied(taskId);
    }
    case "task.reorder": {
      const list_id = await listOfTask(ctx, graphId);
      if (!list_id) return rejected("unknown_task");
      const r = await reorderTask(ctx, { list_id, task_id: graphId, position: requiredPosition(input) });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }

    case "myday.add": {
      const list_id = await listOfTask(ctx, graphId);
      if (!list_id) return rejected("unknown_task");
      const r = await addToMyDay(ctx, { list_id, task_id: graphId });
      if (!r.ok) return rejected(r.reason);
      // Adding puts the task at the top; any other position is a second write.
      if (input.position && !("top" in input.position)) {
        const pos = reorderPosition(input.position, input.ids);
        const date = r.value.day;
        await afterCommit("sync_myday_position_failed", graphId, () =>
          reorderMyDayTask(ctx, { list_id, task_id: graphId, date, position: pos }),
        );
      }
      return applied(graphId);
    }
    case "myday.remove": {
      const list_id = await listOfTask(ctx, graphId);
      if (!list_id) return rejected("unknown_task");
      const r = await removeFromMyDay(ctx, { list_id, task_id: graphId });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }
    case "myday.reorder": {
      const list_id = await listOfTask(ctx, graphId);
      if (!list_id) return rejected("unknown_task");
      const r = await reorderMyDayTask(ctx, { list_id, task_id: graphId, position: requiredPosition(input) });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }

    case "step.create": {
      const task_id = ref("task_id");
      const list_id = await listOfTask(ctx, task_id);
      if (!list_id) return rejected("unknown_task");
      const r = await createStep(ctx, {
        list_id,
        task_id,
        display_name: requiredText(fields, "title"),
        is_checked: optionalBool(fields, "checked"),
      });
      return r.ok ? applied(r.value.item.id) : rejected(r.reason);
    }
    case "step.update": {
      const parent = await ctx.index.findParentOf("step", graphId);
      if (!parent) return rejected("unknown_step");
      const r = await updateStep(ctx, {
        ...parent,
        item_id: graphId,
        display_name: optionalText(fields, "title"),
        is_checked: optionalBool(fields, "checked"),
      });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }
    case "step.delete": {
      const parent = await ctx.index.findParentOf("step", graphId);
      if (!parent) return rejected("unknown_step");
      const r = await deleteStep(ctx, { ...parent, item_id: graphId });
      if (!r.ok && r.reason === "checklist_item_not_found") {
        await bestEffort("index_delete_checklist_item_failed", { task_id: parent.task_id }, () =>
          ctx.index.deleteChecklistItem(parent.task_id, graphId),
        );
      }
      return deleted(r, graphId, "checklist_item_not_found");
    }
    case "step.reorder": {
      const parent = await ctx.index.findParentOf("step", graphId);
      if (!parent) return rejected("unknown_step");
      const r = await reorderStep(ctx, { ...parent, item_id: graphId, position: requiredPosition(input) });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }

    case "link.create": {
      const task_id = ref("task_id");
      const list_id = await listOfTask(ctx, task_id);
      if (!list_id) return rejected("unknown_task");
      const r = await createLink(ctx, {
        list_id,
        task_id,
        application_name: SYNC_LINK_APPLICATION,
        web_url: requiredText(fields, "url"),
        display_name: optionalText(fields, "title"),
      });
      return r.ok ? applied(r.value.linked_resource.id) : rejected(r.reason);
    }
    case "link.update": {
      const parent = await ctx.index.findParentOf("link", graphId);
      if (!parent) return rejected("unknown_link");
      const r = await updateLink(ctx, {
        ...parent,
        resource_id: graphId,
        web_url: optionalText(fields, "url"),
        display_name: optionalText(fields, "title"),
      });
      return r.ok ? applied(graphId) : rejected(r.reason);
    }
    case "link.delete": {
      const parent = await ctx.index.findParentOf("link", graphId);
      if (!parent) return rejected("unknown_link");
      const r = await deleteLink(ctx, { ...parent, resource_id: graphId });
      if (!r.ok && r.reason === "linked_resource_not_found") {
        await bestEffort("index_delete_linked_resource_failed", { task_id: parent.task_id }, () =>
          ctx.index.deleteLinkedResource(parent.task_id, graphId),
        );
      }
      return deleted(r, graphId, "linked_resource_not_found");
    }
  }
}

// The second write of a mutation whose first write committed (a create's
// completion date, a move's or My Day add's position). Its failure is logged,
// never returned: the mutation is applied, and failing it would invite a
// retry that repeats the committed write.
async function afterCommit(event: string, taskId: string, fn: () => Promise<ToolResult<unknown>>): Promise<void> {
  try {
    const r = await fn();
    if (!r.ok) log.warn(event, { task_id: taskId, reason: r.reason });
  } catch (e) {
    log.warn(event, { task_id: taskId, error: e instanceof Error ? e.message : String(e) });
  }
}

// A delete whose target Graph no longer has did what the app asked.
function deleted(r: ToolResult<unknown>, graphId: string, notFound: string): ExecOutcome {
  if (r.ok || r.reason === notFound) return applied(graphId);
  return rejected(r.reason);
}

async function listOfTask(ctx: OpsContext, taskId: string): Promise<string | null> {
  return (await ctx.index.findListForTask(taskId))?.list_id ?? null;
}

// ---- field translation -----------------------------------------------------

function requiredText(fields: Record<string, unknown>, key: string): string {
  const v = fields[key];
  return typeof v === "string" && v.trim() !== "" ? v : invalid(key);
}

function optionalText(fields: Record<string, unknown>, key: string): string | undefined {
  const v = fields[key];
  if (v === undefined) return undefined;
  return typeof v === "string" ? v : invalid(key);
}

function optionalBool(fields: Record<string, unknown>, key: string): boolean | undefined {
  const v = fields[key];
  if (v === undefined) return undefined;
  return typeof v === "boolean" ? v : invalid(key);
}

type TaskFields = Omit<UpdateTaskInput, "list_id" | "task_id" | "if_match">;

// The sync API's task fields (the feed's shapes, section 4.2) → the ops'
// update input. Only fields present are translated; null clears where Graph
// can clear.
export function taskFields(fields: Record<string, unknown>): TaskFields {
  const out: TaskFields = {};
  const has = (k: string) => fields[k] !== undefined;
  if (has("title")) out.title = requiredText(fields, "title");
  if (has("body")) out.body = bodyText(fields.body);
  if (has("status")) out.status = oneOf(fields, "status", STATUS);
  if (has("importance")) out.importance = oneOf(fields, "importance", IMPORTANCE);
  if (has("completed_at")) {
    const v = fields.completed_at;
    if (v === null) out.completed_date = null;
    else if (typeof v === "string" && !Number.isNaN(Date.parse(v))) {
      // To Do keeps completion as a UTC date.
      out.completed_date = new Date(Date.parse(v)).toISOString().slice(0, 10);
    } else invalid("completed_at");
  }
  for (const k of ["due", "start"] as const) {
    if (!has(k)) continue;
    const v = fields[k];
    if (v === null) out[k] = null;
    else if (typeof v === "string" && BARE_DATE.test(v)) out[k] = v;
    else invalid(k);
  }
  if (has("reminder")) {
    const v = fields.reminder;
    if (v === null) {
      out.reminder = null;
      out.isReminderOn = false;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const { on, at } = v as Record<string, unknown>;
      if (typeof on !== "boolean") invalid("reminder");
      if (at === null) out.reminder = null;
      else if (typeof at === "string" && !Number.isNaN(Date.parse(at))) out.reminder = at;
      else if (at !== undefined) invalid("reminder");
      out.isReminderOn = on as boolean;
    } else invalid("reminder");
  }
  if (has("categories")) {
    const v = fields.categories;
    if (!Array.isArray(v) || !v.every((c) => typeof c === "string")) invalid("categories");
    out.categories = v as string[];
  }
  if (has("recurrence")) {
    const v = fields.recurrence;
    if (v !== null && (typeof v !== "object" || Array.isArray(v))) invalid("recurrence");
    out.recurrence = v as TaskFields["recurrence"];
  }
  return out;
}

// A create has nothing to clear, so a null field means "not set"; the
// completion date goes in a second write (Graph's create ignores it).
function createFields(t: TaskFields) {
  const { completed_date: _later, reminder, due, start, recurrence, ...rest } = t;
  return {
    ...rest,
    ...(reminder ? { reminder } : {}),
    ...(due ? { due } : {}),
    ...(start ? { start } : {}),
    ...(recurrence ? { recurrence } : {}),
  };
}

// The feed sends { type, content }; a plain string is accepted too. The ops
// write the body as text, so an HTML body is refused rather than stored with
// its markup showing.
function bodyText(v: unknown): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const { type, content } = v as Record<string, unknown>;
    if (typeof content === "string" && (type === undefined || type === "text")) return content;
  }
  return invalid("body");
}

function oneOf<T extends string>(fields: Record<string, unknown>, key: string, allowed: readonly T[]): T {
  const v = fields[key];
  return typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : invalid(key);
}

// ---- positions -------------------------------------------------------------

function requiredPosition(input: ExecInput): ReorderPosition {
  if (!input.position) return invalid("position");
  return reorderPosition(input.position, input.ids);
}

// { before: sid } → the ops' position on the neighbour's Graph ID. applyBatch
// resolved the neighbour (and rejected the mutation if it couldn't).
export function reorderPosition(p: Position, ids: Record<string, string>): ReorderPosition {
  if ("top" in p) return { kind: "top" };
  if ("bottom" in p) return { kind: "bottom" };
  if ("before" in p) return { kind: "before", reference_id: ids[normalizeSid(p.before)] };
  return { kind: "after", reference_id: ids[normalizeSid(p.after)] };
}
