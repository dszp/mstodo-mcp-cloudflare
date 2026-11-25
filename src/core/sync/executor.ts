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
import { createLink, deleteLink, findCreatedLinks, updateLink } from "../ops/links";
import { createList, deleteList, findCreatedLists, reorderList, setListAppearance, setListSync, updateList } from "../ops/lists";
import { LIST_SYNC_VALUES, type ListSync } from "../config/sync-policy";
import { addToMyDay, removeFromMyDay, reorderMyDayTask, todayInTimeZone } from "../ops/my-day";
import type { ReorderPosition } from "../ops/position";
import type { ToolResult } from "../ops/result";
import { createStep, deleteStep, findCreatedSteps, reorderStep, updateStep } from "../ops/steps";
import {
  createTask,
  deleteTask,
  findCreatedTasks,
  moveTask,
  refreshTask,
  reorderTask,
  updateTask,
  type UpdateTaskInput,
} from "../ops/tasks";
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
// throttling, auth and the write queue. Only what is certainly permanent is
// `rejected` (stored for good); anything that may clear on its own, or after
// the owner signs in again, is `failed` with retry: true so the app keeps the
// edit. On a create, a failure after the request may have reached Graph is
// also `ambiguous`: the retry looks for what it made before creating again.
async function outcomeOfThrown(ctx: OpsContext, input: ExecInput, e: unknown): Promise<ExecOutcome> {
  const out = await classify(ctx, input, e);
  if (!out.ok && out.retry && input.op.endsWith(".create") && mayHaveWritten(e)) return { ...out, ambiguous: true };
  return out;
}

// A 5xx, a dropped connection, or an error we can't place: Graph may have
// committed the write. A 429, 401 or a refused lease means it never ran.
function mayHaveWritten(e: unknown): boolean {
  if (e instanceof GraphError || e instanceof SubstrateError) return e.status >= 500;
  return !(e instanceof WriteBusyError) && !isReauthRequired(e) && !(e instanceof Error && e.message === "not_authenticated");
}

async function classify(ctx: OpsContext, input: ExecInput, e: unknown): Promise<ExecOutcome> {
  // No stored Microsoft tokens at all is the same state for the app: the
  // owner has to sign in before anything syncs. A 401 that survived the
  // client's refresh-and-retry is that too.
  if (isReauthRequired(e) || (e instanceof Error && e.message === "not_authenticated")) return retryable("reauth_required");
  if ((e instanceof GraphError || e instanceof SubstrateError) && e.status === 401) return retryable("reauth_required");
  if (e instanceof WriteBusyError) return retryable("write_busy");
  if (e instanceof GraphError) return graphOutcome(`graph_${e.status}`, e.status);
  // The index throws a plain Error("my_day_unavailable") (flattened over DO
  // RPC) when the Exchange Online scope isn't consented; it clears when the
  // owner re-authorizes.
  if (e instanceof Error && e.message.includes("my_day_unavailable")) return retryable("my_day_unavailable");
  if (e instanceof SubstrateError) {
    if (e.status === 403) {
      // Same latch as the MCP tools: stop trying Substrate until re-consent.
      await bestEffort("mark_my_day_unavailable_failed", {}, () => ctx.index.markMyDayUnavailable());
      return retryable("my_day_unavailable");
    }
    return graphOutcome(`substrate_${e.status}`, e.status);
  }
  // fetch() rejects with a TypeError when the network fails.
  if (e instanceof TypeError) return retryable("network_error");
  // Everything else — a Microsoft token endpoint outage, a refresh racing a
  // re-authorization, the index unreachable — is the server's trouble, not
  // the edit's.
  log.error("sync_mutation_failed", { op: input.op, error: e instanceof Error ? e.message : String(e) });
  return retryable("internal_error");
}

// 429 and 5xx: throttling and outages. 409 and 423: a conflicting or locked
// item, which passes. 403: not stored, since a permission can come back. Any
// other 4xx is a request Graph will refuse every time.
function graphOutcome(error: string, status: number): ExecOutcome {
  if (status === 429 || status >= 500 || status === 409 || status === 423) return retryable(error);
  if (status === 403) return { ok: false, error, retry: false };
  return rejected(error);
}

async function execute(ctx: OpsContext, input: ExecInput): Promise<ExecOutcome> {
  const { op, fields } = input;
  if (NEEDS_MY_DAY.has(op) || (op === "task.move" && input.position)) {
    if (!myDayEnabled(ctx.env)) return rejected("my_day_disabled");
  }
  const graphId = input.graphId ?? "";
  const ref = (key: "list_id" | "task_id" | "group_id"): string => {
    const sid = fields[key];
    if (typeof sid !== "string") return invalid(key);
    // applyBatch resolved every sid in fields before calling.
    return input.ids[normalizeSid(sid)];
  };

  switch (op) {
    case "list.create": {
      const display_name = requiredText(fields, "name");
      if (input.priorAttemptMs !== undefined) {
        // An earlier attempt may have made it (section 5.4).
        const found = await findCreatedLists(ctx, { display_name, since_ms: input.priorAttemptMs, sid: input.sid });
        if (found.length === 1) return applied(found[0].id);
        if (found.length > 1) return rejected("ambiguous_create");
      }
      const r = await createList(ctx, { display_name, sid: input.sid });
      return r.ok ? applied(r.value.list.id) : rejected(r.reason);
    }
    case "list.update": {
      // Any one field is an update; a list.update with none is invalid.
      const sync = fields.sync;
      const theme = fields.theme === undefined ? undefined : listTheme(fields.theme);
      // group_id: a group's sid (applyBatch resolved it to the Substrate Id),
      // or null to ungroup.
      const group_id =
        fields.group_id === undefined ? undefined : fields.group_id === null ? null : ref("group_id");
      const appearance = theme !== undefined || group_id !== undefined;
      const name = fields.name !== undefined || (sync === undefined && !appearance) ? requiredText(fields, "name") : undefined;
      if (sync !== undefined && !(LIST_SYNC_VALUES as readonly unknown[]).includes(sync)) invalid("sync");
      if (appearance && !myDayEnabled(ctx.env)) return rejected("list_appearance_unavailable");
      if (name !== undefined) {
        const r = await updateList(ctx, { list_id: graphId, display_name: name });
        if (!r.ok) return rejected(r.reason);
      }
      if (sync !== undefined) {
        const r = await setListSync(ctx, { list_id: graphId, sync: sync as ListSync });
        if (!r.ok) return rejected(r.reason);
      }
      if (appearance) {
        const r = await setListAppearance(ctx, { list_id: graphId, theme, group_id });
        if (!r.ok) return rejected(r.reason);
      }
      return applied(graphId);
    }
    case "list.reorder": {
      if (!myDayEnabled(ctx.env)) return rejected("list_appearance_unavailable");
      if (!input.position) invalid("position");
      const p = input.position!;
      let position: Parameters<typeof reorderList>[1]["position"];
      if ("top" in p) position = { kind: "top" };
      else if ("bottom" in p) position = { kind: "bottom" };
      else {
        // The neighbour is a list or a group; applyBatch left it to us.
        const kind = "before" in p ? "before" : "after";
        const sid = normalizeSid("before" in p ? p.before : p.after);
        const r = await ctx.index.resolveSids([{ kind: "list", sid }, { kind: "list_group", sid }]);
        const hit = [r[`list:${sid}`], r[`list_group:${sid}`]].find((x) => x?.graph_id && x.live);
        if (!hit?.graph_id) return rejected("unknown_reference");
        position = { kind, reference_id: hit.graph_id };
      }
      const r = await reorderList(ctx, { list_id: graphId, position });
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
      const title = requiredText(fields, "title");
      const t = completion(taskFields(fields), today(ctx));
      if (input.priorAttemptMs !== undefined) {
        // An earlier attempt may have made it (section 5.4).
        const found = await findCreatedTasks(ctx, { list_id, title, since_ms: input.priorAttemptMs, sid: input.sid });
        if (found.length === 1) return applied(found[0].id);
        if (found.length > 1) return rejected("ambiguous_create");
      }
      const r = await createTask(ctx, { list_id, title, ...createFields(t), sid: input.sid });
      if (!r.ok) return rejected(r.reason);
      const taskId = r.value.task.id;
      // Graph's create takes no completion date; a backdated completion is a
      // second write. The task exists either way, so its failure is logged.
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
      const t = completion(taskFields(fields), today(ctx));
      let r = await updateTask(ctx, { list_id, task_id: graphId, ...t });
      if (!r.ok && r.reason === "recurring_completion_unsupported") {
        // A repeating task can't keep a completion date: completing it moves
        // it to the next occurrence. Complete it without one.
        const { completed_date: _dropped, ...rest } = t;
        r = await updateTask(ctx, { list_id, task_id: graphId, ...rest, status: rest.status ?? "completed" });
      }
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
        const v = r.value;
        if (v.status === "aborted") {
          // The source is untouched. A destination copy that couldn't be
          // removed is a stray task only a person can judge; say where it is.
          if (v.orphan_task_id) {
            log.error("sync_move_orphan", { task_id: graphId, orphan_task_id: v.orphan_task_id, to_list_id });
          }
          // Throttling or an outage may pass; a reference attachment or an
          // oversized file won't.
          return { ok: false, error: `move_aborted:${v.error}`, retry: v.transient === true };
        }
        taskId = v.task_id;
        if (v.method === "copy_delete" && v.warning) await finishCopyMove(ctx, graphId, from_list_id, to_list_id, taskId);
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
      const title = requiredText(fields, "title");
      if (input.priorAttemptMs !== undefined) {
        const found = await findCreatedSteps(ctx, { list_id, task_id, title, since_ms: input.priorAttemptMs, sid: input.sid });
        if (found.length === 1) return applied(found[0].id);
        if (found.length > 1) return rejected("ambiguous_create");
      }
      const r = await createStep(ctx, { list_id, task_id, display_name: title, is_checked: optionalBool(fields, "checked"), sid: input.sid });
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
      if (input.priorAttemptMs !== undefined) {
        // An earlier attempt may have made it: it carries the sid as its
        // externalId, so the match is exact (section 5.4).
        const found = await findCreatedLinks(ctx, { list_id, task_id, sid: input.sid });
        if (found.length >= 1) return applied(found[0].id);
      }
      const r = await createLink(ctx, {
        list_id,
        task_id,
        application_name: SYNC_LINK_APPLICATION,
        external_id: input.sid,
        sid: input.sid,
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

// A copy-and-delete move whose source delete failed: the copy exists, and the
// mirror holds both tasks with the app's sid still on the source. The sid
// goes to the copy (what the app asked for) and the source delete is tried
// once more. If the source still won't go, it is mirrored again under a sid
// of its own, so the app sees it as the extra task it is, and logged; the
// move is not reported failed, since a retry would make another copy.
async function finishCopyMove(ctx: OpsContext, sourceId: string, from: string, to: string, copyId: string): Promise<void> {
  await bestEffort("index_move_task_failed", { task_id: sourceId }, () => ctx.index.moveTask(sourceId, to, copyId));
  await bestEffort("index_forget_subresources_failed", { task_id: copyId }, () => ctx.index.forgetSubresources(copyId));
  let gone = false;
  try {
    const r = await deleteTask(ctx, { list_id: from, task_id: sourceId });
    gone = r.ok || r.reason === "task_not_found";
  } catch (e) {
    log.warn("sync_move_source_delete_retry_failed", { task_id: sourceId, error: e instanceof Error ? e.message : String(e) });
  }
  if (gone) return;
  log.error("sync_move_source_left", { source_task_id: sourceId, from_list_id: from, copy_task_id: copyId, to_list_id: to });
  await afterCommit("sync_move_source_refresh_failed", sourceId, () => refreshTask(ctx, { list_id: from, task_id: sourceId }));
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

// A list theme: { color?, background? }, each one of To Do's preset names.
// Names aren't checked against a list (the full set isn't known); a name is
// short text, which keeps arbitrary payloads out of Substrate. There is no
// "no theme": Substrate ignores null and stores "" as a name To Do doesn't
// know (observed 2026-11-25), so neither is accepted.
const THEME_NAME = /^[A-Za-z0-9_-]{1,64}$/;
function listTheme(v: unknown): { color?: string; background?: string } {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return invalid("theme");
  const out: { color?: string; background?: string } = {};
  for (const [k, val] of Object.entries(v)) {
    if (k !== "color" && k !== "background") invalid("theme");
    if (typeof val !== "string" || !THEME_NAME.test(val)) invalid("theme");
    out[k as "color" | "background"] = val as string;
  }
  if (Object.keys(out).length === 0) invalid("theme");
  return out;
}

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
    // A bare date in the owner's calendar, like due and start: To Do keeps
    // completion at date granularity.
    const v = fields.completed_at;
    if (v === null) out.completed_date = null;
    else if (typeof v === "string" && BARE_DATE.test(v)) out.completed_date = v;
    else invalid("completed_at");
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
const today = (ctx: OpsContext) => todayInTimeZone(ctx.env.TIMEZONE);

// Completing a task today is a status change, not a backdate: Graph stamps
// the date itself, and a repeating task accepts it (it can't hold a set
// date). Only a completion on another day is sent as completed_date.
export function completion(t: TaskFields, todayDate: string): TaskFields {
  if (t.completed_date == null || t.completed_date !== todayDate) return t;
  const { completed_date: _today, ...rest } = t;
  return { ...rest, status: rest.status ?? "completed" };
}

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
