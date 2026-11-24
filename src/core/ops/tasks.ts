import { log } from "../log";
import { myDayEnabled } from "../auth/microsoft";
import { GraphError, type GraphClient } from "../graph/client";
import { SubstrateError, type SubstrateTask } from "../graph/substrate-client";
import { LinkedResourceSchema, TodoTaskSchema, type Attachment, type TodoTask } from "../graph/types";
import { createChecklistItem, createLinkedResource, getFileAttachment, listAttachments } from "../graph/todo-resources";
import { loadAttachmentConfig, loadLinkRules } from "../config/loader";
import { runLinkRules, type LinkRuleMatch } from "../config/link-rules-engine";
import { attachFile, bytesFromBase64, PER_FILE_MAX_BYTES } from "../upload/graph-upload";
import { toGraphDate, toGraphDateTime } from "../util/dates";
import { bestEffort, getGraphInnerErrorCode, isGraphNotFound, reserveSid, type OpsContext } from "./context";
import { buildMoveCopyBody, decideAfterReparentFailure, isReparentConfirmed } from "./move-task";
import { committedDatePart } from "./my-day";
import { computeOrder, orderValues, type ReorderPosition } from "./position";
import { err, ok, type ToolResult } from "./result";

// task.create / task.update / task.delete / task.move / task.reorder
// (docs/SYNC-API.md section 5.2).

const LISTS_URL = "https://graph.microsoft.com/v1.0/me/todo/lists";
const tasksUrl = (listId: string) => `${LISTS_URL}/${encodeURIComponent(listId)}/tasks`;
const taskUrl = (listId: string, taskId: string) => `${tasksUrl(listId)}/${encodeURIComponent(taskId)}`;

const upsertTask = (ctx: OpsContext, task: TodoTask, listId: string) =>
  bestEffort("index_upsert_task_failed", { task_id: task.id }, () => ctx.index.upsertTask(task, listId));
const deleteTaskRow = (ctx: OpsContext, taskId: string) =>
  bestEffort("index_delete_task_failed", { task_id: taskId }, () => ctx.index.deleteTask(taskId));

// ---- Dates -----------------------------------------------------------------

// Graph dateTimeTimeZone fields for the task date inputs. undefined = not
// supplied (omitted), null = clear (sent as null). Graph keeps only the date of
// due/start but the full time of reminder, so they convert differently — see
// util/dates.ts. Naive values are the owner's local time (TIMEZONE).
const GRAPH_DATE_KEYS = {
  due: { key: "dueDateTime", convert: toGraphDate },
  reminder: { key: "reminderDateTime", convert: toGraphDateTime },
  start: { key: "startDateTime", convert: toGraphDate },
} as const;

type DateInputs = Partial<Record<keyof typeof GRAPH_DATE_KEYS, string | null | undefined>>;

function graphDateFields(timeZone: string, input: DateInputs): ToolResult<Record<string, unknown>> {
  const fields: Record<string, unknown> = {};
  for (const [param, { key, convert }] of Object.entries(GRAPH_DATE_KEYS)) {
    const value = input[param as keyof typeof GRAPH_DATE_KEYS];
    if (value === undefined) continue;
    if (value === null) {
      fields[key] = null;
      continue;
    }
    const converted = convert(value, timeZone);
    if (!converted) {
      return err("invalid_date", {
        field: param,
        value,
        hint: "Use ISO 8601: a date (2026-10-20), a local date/time (2026-10-20T09:00), or one with an offset (2026-10-20T09:00:00-04:00).",
      });
    }
    fields[key] = converted;
  }
  return ok(fields);
}

// ---- Link rules ------------------------------------------------------------

export type LinkRulesOutcome = {
  created: LinkRuleMatch[];
  skipped: Array<{ match: LinkRuleMatch; reason: string }>;
  failed: Array<{ match: LinkRuleMatch; error: string }>;
  // Set when the rules couldn't run at all (config read, the re-fetch of the
  // task's links). The task write itself already succeeded.
  error?: string;
};

// The link-rule step after a committed task write: never throws, so a failure
// here can't turn an applied create/update into an error that invites a retry
// (and, for a create, a duplicate task).
async function linkRulesAfterWrite(ctx: OpsContext, listId: string, load: () => Promise<TodoTask>): Promise<LinkRulesOutcome> {
  try {
    return await applyLinkRules(ctx, listId, await load());
  } catch (e) {
    log.warn("link_rules_failed", { error: String(e) });
    return { created: [], skipped: [], failed: [], error: e instanceof Error ? e.message : String(e) };
  }
}

// Run the configured link rules against a task and POST the single match (if
// any) as a linked resource. To Do allows one linked resource per task, so this
// creates at most one and skips (never clobbers) when the task already has one.
// Pass a task fetched with $expand=linkedResources so that check is accurate;
// a freshly created task's undefined linkedResources correctly counts as none.
// Non-fatal: a failed create is logged and returned in `failed`.
async function applyLinkRules(ctx: OpsContext, listId: string, task: TodoTask): Promise<LinkRulesOutcome> {
  const config = await loadLinkRules(ctx.env);
  if (config.rules.filter((r) => r.enabled).length === 0) return { created: [], skipped: [], failed: [] };
  const matches = runLinkRules(config, task);
  if (matches.length === 0) return { created: [], skipped: [], failed: [] };

  let hasLink = (task.linkedResources ?? []).length > 0;
  const out: LinkRulesOutcome = { created: [], skipped: [], failed: [] };
  const baseUrl = `${taskUrl(listId, task.id)}/linkedResources`;
  for (const match of matches) {
    if (hasLink) {
      out.skipped.push({ match, reason: "todo_one_linked_resource_per_task" });
      continue;
    }
    try {
      await ctx.graph.postJson(
        baseUrl,
        { applicationName: match.applicationName, displayName: match.displayName, externalId: match.externalId, webUrl: match.url },
        LinkedResourceSchema,
      );
      out.created.push(match);
      hasLink = true;
    } catch (e) {
      // Graph's own signal for the one-per-task limit — a skip, not a failure.
      if (e instanceof GraphError && getGraphInnerErrorCode(e.detail) === "LinkedResourceSizeExceeded") {
        out.skipped.push({ match, reason: "todo_one_linked_resource_per_task" });
        continue;
      }
      const error =
        e instanceof GraphError ? (e.detail ? `${e.message}: ${e.detail}` : e.message) : e instanceof Error ? e.message : String(e);
      out.failed.push({ match, error });
      log.warn("link_rules_create_failed", { rule_id: match.rule_id, url: match.url, error });
    }
  }
  return out;
}

// ---- create / update / delete ----------------------------------------------

type Importance = "low" | "normal" | "high";
type Status = "notStarted" | "inProgress" | "completed" | "waitingOnOthers" | "deferred";

export type CreateTaskInput = {
  list_id: string;
  title: string;
  body?: string;
  due?: string;
  reminder?: string;
  start?: string;
  importance?: Importance;
  status?: Status;
  isReminderOn?: boolean;
  categories?: string[];
  recurrence?: TodoTask["recurrence"];
  // The sync API's sid for the new task (see reserveSid).
  sid?: string;
};

// Only supplied fields are sent. The body is plain text.
export function createTask(
  ctx: OpsContext,
  input: CreateTaskInput,
): Promise<ToolResult<{ list_id: string; task: TodoTask; link_rules: LinkRulesOutcome }>> {
  const { list_id } = input;
  return ctx.writes.run(async () => {
    const dates = graphDateFields(ctx.env.TIMEZONE, input);
    if (!dates.ok) return dates;
    const graphBody: Record<string, unknown> = { title: input.title, ...dates.value };
    if (input.body !== undefined) graphBody.body = { content: input.body, contentType: "text" };
    if (input.importance !== undefined) graphBody.importance = input.importance;
    if (input.status !== undefined) graphBody.status = input.status;
    if (input.isReminderOn !== undefined) graphBody.isReminderOn = input.isReminderOn;
    if (input.categories !== undefined) graphBody.categories = input.categories;
    if (input.recurrence !== undefined) graphBody.recurrence = input.recurrence;
    let task: TodoTask;
    try {
      task = await ctx.graph.postJson(tasksUrl(list_id), graphBody, TodoTaskSchema);
    } catch (e) {
      if (isGraphNotFound(e)) return err("list_not_found", { list_id });
      throw e;
    }
    // Committed: nothing below may fail the op.
    await reserveSid(ctx, "task", input.sid, task.id);
    await upsertTask(ctx, task, list_id);
    const link_rules = await linkRulesAfterWrite(ctx, list_id, async () => task);
    // A task this create just made has no steps, links or attachments, so its
    // sub-resources are known now, unless a link rule may have added a link
    // (the rules write to Graph only); then the scan finds it.
    const ruleTouched = link_rules.created.length + link_rules.failed.length > 0 || link_rules.error !== undefined;
    if (!ruleTouched) {
      await bestEffort("index_mark_subresources_failed", { task_id: task.id }, () =>
        ctx.index.replaceChecklistItems(task.id, list_id, []),
      );
    }
    return ok({ list_id, task, link_rules });
  });
}

export type UpdateTaskInput = {
  list_id: string;
  task_id: string;
  title?: string;
  body?: string;
  due?: string | null;
  reminder?: string | null;
  start?: string | null;
  // A UTC date (YYYY-MM-DD): To Do keeps completion at date granularity. null
  // clears it.
  completed_date?: string | null;
  importance?: Importance;
  status?: Status;
  isReminderOn?: boolean;
  categories?: string[];
  recurrence?: TodoTask["recurrence"] | null;
  // ETag from a prior read; sent as If-Match.
  if_match?: string;
};

// PATCH with only the supplied fields; null clears a date or the recurrence.
// link_rules is present only when title or body changed (the fields the rules
// match on).
export function updateTask(
  ctx: OpsContext,
  input: UpdateTaskInput,
): Promise<ToolResult<{ list_id: string; task: TodoTask; link_rules?: LinkRulesOutcome }>> {
  const { list_id, task_id, completed_date, status, if_match } = input;
  const url = taskUrl(list_id, task_id);
  return ctx.writes.run(async () => {
    const dates = graphDateFields(ctx.env.TIMEZONE, input);
    if (!dates.ok) return dates;
    const graphBody: Record<string, unknown> = { ...dates.value };
    if (input.title !== undefined) graphBody.title = input.title;
    if (input.body !== undefined) graphBody.body = { content: input.body, contentType: "text" };
    // completed_date stays a UTC date: converting local midnight to UTC would
    // move the date back a day for any zone east of UTC.
    if (completed_date !== undefined) {
      graphBody.completedDateTime = completed_date !== null ? { dateTime: completed_date, timeZone: "UTC" } : null;
      // Graph keeps completedDateTime only while status is 'completed'; imply
      // it for a backdate unless the caller set status explicitly.
      if (completed_date !== null && status === undefined) graphBody.status = "completed";
    }
    if (input.importance !== undefined) graphBody.importance = input.importance;
    if (status !== undefined) graphBody.status = status;
    if (input.isReminderOn !== undefined) graphBody.isReminderOn = input.isReminderOn;
    if (input.categories !== undefined) graphBody.categories = input.categories;
    if (input.recurrence !== undefined) graphBody.recurrence = input.recurrence;

    // Backdating needs a real notStarted->completed transition: Graph ignores
    // completedDateTime on a re-PATCH of an already-completed task, and a
    // recurring task can't hold one at all (completing advances it to the next
    // occurrence). So look the task up, refuse recurring, and reset an
    // already-completed one to notStarted before the PATCH below.
    let mainIfMatch = if_match;
    if (completed_date !== undefined && completed_date !== null) {
      let current: TodoTask;
      try {
        current = await ctx.graph.getJson(url, TodoTaskSchema);
      } catch (e) {
        if (isGraphNotFound(e)) return err("task_not_found", { list_id, task_id });
        throw e;
      }
      if (current.recurrence != null) {
        return err("recurring_completion_unsupported", {
          list_id,
          task_id,
          hint: "Completing a recurring task advances it to the next occurrence, so To Do can't keep a fixed completion date. Remove the recurrence first, or complete it without completed_date.",
        });
      }
      if ((current.status ?? "") === "completed") {
        await ctx.graph.patchJson(url, { status: "notStarted" }, TodoTaskSchema, { ifMatch: if_match });
        // The reset consumed the caller's ETag; don't reuse a stale one.
        mainIfMatch = undefined;
      }
    }

    let task: TodoTask;
    try {
      task = await ctx.graph.patchJson(url, graphBody, TodoTaskSchema, { ifMatch: mainIfMatch });
    } catch (e) {
      if (isGraphNotFound(e)) return err("task_not_found", { list_id, task_id });
      if (e instanceof GraphError && e.status === 412) {
        return err("precondition_failed", {
          list_id,
          task_id,
          hint: "ETag mismatch — task was modified since last read. Re-fetch and retry.",
        });
      }
      throw e;
    }
    // Committed: nothing below may fail the op.
    await upsertTask(ctx, task, list_id);
    if (input.title === undefined && input.body === undefined) return ok({ list_id, task });
    // The PATCH response has no linkedResources; re-fetch with them so the
    // rules see an existing link and don't add a second.
    const expandUrl = new URL(url);
    expandUrl.searchParams.set("$expand", "linkedResources");
    const link_rules = await linkRulesAfterWrite(ctx, list_id, () => ctx.graph.getJson(expandUrl.toString(), TodoTaskSchema));
    return ok({ list_id, task, link_rules });
  });
}

export function deleteTask(
  ctx: OpsContext,
  input: { list_id: string; task_id: string },
): Promise<ToolResult<{ list_id: string; task_id: string }>> {
  const { list_id, task_id } = input;
  return ctx.writes.run(async () => {
    try {
      await ctx.graph.deleteResource(taskUrl(list_id, task_id));
      await deleteTaskRow(ctx, task_id);
      return ok({ list_id, task_id });
    } catch (e) {
      if (isGraphNotFound(e)) return err("task_not_found", { list_id, task_id });
      throw e;
    }
  });
}

// ---- create recovery (docs/SYNC-API.md section 5.4) -----------------------

// Graph's clock against ours: how far before an attempt a create it made may
// be stamped.
const CREATE_SKEW_MS = 5_000;
const after = (iso: string | undefined, sinceMs: number) => !!iso && Date.parse(iso) >= sinceMs - CREATE_SKEW_MS;

// Tasks in `list_id` titled `title` and created at or after `since_ms`: what
// an earlier create attempt that lost its response may have made. Asks Graph,
// not the mirror, which can lag. A single match is written through, so the
// caller can adopt it.
export async function findCreatedTasks(
  ctx: OpsContext,
  input: { list_id: string; title: string; since_ms: number; sid?: string },
): Promise<TodoTask[]> {
  const url = new URL(tasksUrl(input.list_id));
  url.searchParams.set("$filter", `createdDateTime ge ${new Date(input.since_ms - CREATE_SKEW_MS).toISOString()}`);
  let res: Awaited<ReturnType<GraphClient["getAllPages"]>>;
  try {
    res = await ctx.graph.getAllPages(url.toString(), TodoTaskSchema);
  } catch (e) {
    // A list that refuses the filter is read whole; the match below is the
    // real test either way.
    if (!(e instanceof GraphError && e.status === 400)) throw e;
    res = await ctx.graph.getAllPages(tasksUrl(input.list_id), TodoTaskSchema);
  }
  const items = res.status === 200 ? (res.items as TodoTask[]) : [];
  const titled = items.filter((t) => t.title === input.title && after(t.createdDateTime, input.since_ms));
  // A task another mutation made (its sid was the app's) is not this one's.
  const owned = titled.length ? await ctx.index.createCandidates("task", titled.map((t) => t.id)) : {};
  const found = titled.filter((t) => !owned[t.id]?.app_owned);
  if (found.length === 1) {
    await reserveSid(ctx, "task", input.sid, found[0].id);
    await upsertTask(ctx, found[0], input.list_id);
  }
  return found;
}

// Re-reads one task into the mirror (a move's leftover source).
export async function refreshTask(ctx: OpsContext, input: { list_id: string; task_id: string }): Promise<ToolResult<TodoTask>> {
  try {
    const task = await ctx.graph.getJson(taskUrl(input.list_id, input.task_id), TodoTaskSchema);
    await upsertTask(ctx, task, input.list_id);
    return ok(task);
  } catch (e) {
    if (isGraphNotFound(e)) return err("task_not_found", input);
    throw e;
  }
}

// ---- move ------------------------------------------------------------------

type MoveIds = { task_id: string; previous_task_id: string; from_list_id: string; to_list_id: string };

// The outcomes of a move that ran. `aborted` is a copy/delete that stopped
// before deleting the source: the source is intact (task_id is still valid)
// and the destination copy was removed unless cleanup_succeeded is false, in
// which case orphan_task_id names it.
export type MoveTaskOutcome =
  | ({ status: "moved"; method: "substrate_reparent" } & MoveIds & { note?: string })
  | ({ status: "moved"; method: "copy_delete" } & MoveIds & {
      checklist_copied: number;
      linked_resources_copied: number;
      attachments_copied: number;
      my_day_carried: boolean;
      my_day_skipped_reason?: string;
      warning?: string;
    })
  | ({
      status: "aborted";
      method: "copy_delete";
      error: string;
      from_list_id: string;
      to_list_id: string;
      task_id: string;
      cleanup_succeeded: boolean;
      orphan_task_id?: string;
    } & MoveAbortDetail);

type MoveAbortDetail = {
  detail?: string;
  // The step that stopped the move failed in a way a later retry may not
  // (throttling, an outage, a dropped connection).
  transient?: boolean;
  attachment_id?: string;
  size?: number;
  max?: number;
  checklist_copied?: number;
  linked_resources_copied?: number;
  attachments_copied?: number;
};

// Moves a task between lists. With My Day on, the primary path is a lossless
// Substrate re-parent: one PATCH moves the same item, so steps, the link,
// attachments and My Day ride along, and the immutable task id is kept. When
// Substrate is unavailable, or a re-parent didn't confirm and the source is
// confirmed still present, it falls back to copy-then-delete: create in the
// destination, copy steps / the link / attachment bytes, carry My Day, then
// delete the source. A required-copy failure aborts with the source untouched.
// Not idempotent: retrying a failed copy can create a second destination task.
export function moveTask(
  ctx: OpsContext,
  input: { task_id: string; from_list_id: string; to_list_id: string },
): Promise<ToolResult<MoveTaskOutcome>> {
  const { task_id, from_list_id, to_list_id } = input;
  return ctx.writes.run(async () => {
    // The source with its sub-resources: the fallback copies them, and this is
    // the not-found check. ($expand carries no attachment bytes, and in fact
    // no attachments at all — those are listed separately below.)
    const srcUrl = new URL(taskUrl(from_list_id, task_id));
    srcUrl.searchParams.set("$expand", "checklistItems,linkedResources,attachments");
    let srcTask: TodoTask;
    try {
      srcTask = await ctx.graph.getJson(srcUrl.toString(), TodoTaskSchema);
    } catch (e) {
      if (isGraphNotFound(e)) return err("task_not_found", { list_id: from_list_id, task_id });
      throw e;
    }

    // ---- PRIMARY: lossless Substrate re-parent ----
    if (myDayEnabled(ctx.env)) {
      const r = await reparentViaSubstrate(ctx, to_list_id, task_id);
      if (r.ok) {
        // Immutable ids survive a re-parent; Substrate's response carries the
        // new default REST id, which must not become the key. One transaction
        // keeps the task's steps and My Day fields; the upsert then refreshes
        // its Graph columns (and has_checklist / has_attachments) from srcTask.
        await bestEffort("index_move_task_failed", { task_id }, () => ctx.index.moveTask(task_id, to_list_id));
        await upsertTask(ctx, srcTask, to_list_id);
        return ok({ status: "moved", method: "substrate_reparent", task_id, previous_task_id: task_id, from_list_id, to_list_id });
      }
      if (r.attempted) {
        // A PATCH was sent but the move isn't confirmed — it may have committed
        // and lost its response, so a blind copy could duplicate. Re-check the
        // source before any fallback create.
        const recheck = await recheckSource(ctx.graph, from_list_id, task_id);
        if (decideAfterReparentFailure(recheck) === "treat_as_moved") {
          await deleteTaskRow(ctx, task_id);
          return ok({
            status: "moved",
            method: "substrate_reparent",
            task_id,
            previous_task_id: task_id,
            from_list_id,
            to_list_id,
            note: r.task
              ? "Re-parent response was not fully confirmed; treated as moved (delta sync will reconcile)."
              : "Source no longer present after an ambiguous re-parent; treated as moved. The task id may have changed — delta sync will reconcile.",
          });
        }
        // Source confirmed still present: safe to copy.
      }
      // Not attempted (Substrate unavailable, no PATCH sent): straight to copy.
    }
    return copyThenDelete(ctx, srcTask, input);
  });
}

const transient = (e: unknown) =>
  ((e instanceof GraphError || e instanceof SubstrateError) && (e.status === 429 || e.status >= 500)) || e instanceof TypeError;
const cause = (e: unknown) => ({ detail: String(e), transient: transient(e) });

async function copyThenDelete(
  ctx: OpsContext,
  srcTask: TodoTask,
  { task_id, from_list_id, to_list_id }: { task_id: string; from_list_id: string; to_list_id: string },
): Promise<ToolResult<MoveTaskOutcome>> {
  const { graph } = ctx;
  // The index isn't touched until the outcome is known: on success the
  // source's row is re-keyed to the copy (so its stable id follows the task),
  // on abort there is nothing to undo.
  let newTask: TodoTask;
  try {
    newTask = await graph.postJson(tasksUrl(to_list_id), buildMoveCopyBody(srcTask), TodoTaskSchema);
  } catch (e) {
    if (isGraphNotFound(e)) return err("list_not_found", { list_id: to_list_id });
    throw e;
  }
  const newId = newTask.id;

  // Abort with best-effort removal of the destination copy. The source was not
  // touched, so it stays the valid, complete task.
  const abort = async (error: string, extra: MoveAbortDetail = {}): Promise<ToolResult<MoveTaskOutcome>> => {
    let cleanup_succeeded = true;
    try {
      await graph.deleteResource(taskUrl(to_list_id, newId));
    } catch (e) {
      cleanup_succeeded = false;
      log.warn("move_fallback_cleanup_failed", { newId, error: String(e) });
    }
    return ok({
      status: "aborted",
      method: "copy_delete",
      error,
      from_list_id,
      to_list_id,
      task_id,
      cleanup_succeeded,
      ...extra,
      ...(cleanup_succeeded ? {} : { orphan_task_id: newId }),
    });
  };

  // Steps, in creation order.
  let checklist_copied = 0;
  const items = (srcTask.checklistItems ?? [])
    .slice()
    .sort((a, b) => (a.createdDateTime ?? "").localeCompare(b.createdDateTime ?? ""));
  for (const it of items) {
    try {
      await createChecklistItem(graph, to_list_id, newId, { displayName: it.displayName ?? "", isChecked: it.isChecked });
      checklist_copied += 1;
    } catch (e) {
      return abort("checklist_copy_failed", { ...cause(e), checklist_copied });
    }
  }

  // The linked resource (at most one per task).
  let linked_resources_copied = 0;
  const lr = (srcTask.linkedResources ?? [])[0];
  if (lr) {
    try {
      await createLinkedResource(graph, to_list_id, newId, {
        applicationName: lr.applicationName ?? "Linked resource",
        displayName: lr.displayName,
        externalId: lr.externalId ?? undefined,
        webUrl: lr.webUrl ?? undefined,
      });
      linked_resources_copied += 1;
    } catch (e) {
      return abort("linked_resource_copy_failed", { ...cause(e), checklist_copied });
    }
  }

  // Attachments: bytes round-trip through this server (Graph has no copy).
  // Listed from the collection — `$expand=attachments` is silently ignored on
  // a todoTask, so srcTask.attachments would be empty and the source deleted
  // with its files.
  let attachments_copied = 0;
  if (srcTask.hasAttachments) {
    let cfg: Awaited<ReturnType<typeof loadAttachmentConfig>>;
    let accessToken: string;
    try {
      cfg = await loadAttachmentConfig(ctx.env);
      accessToken = await ctx.accessToken();
    } catch (e) {
      return abort("attachment_setup_failed", { ...cause(e), checklist_copied, linked_resources_copied });
    }
    let srcAttachments: Attachment[];
    try {
      srcAttachments = await listAttachments(graph, from_list_id, task_id);
    } catch (e) {
      return abort("attachment_list_failed", { ...cause(e), checklist_copied, linked_resources_copied });
    }
    if (srcAttachments.length === 0) {
      // hasAttachments but none listed: an inconsistent read. Keep the source.
      return abort("attachment_enumeration_empty", { checklist_copied, linked_resources_copied });
    }
    for (const meta of srcAttachments) {
      const counts = { checklist_copied, linked_resources_copied, attachments_copied };
      if (meta["@odata.type"] !== "#microsoft.graph.taskFileAttachment") {
        // A reference attachment has no bytes to re-upload; don't drop it silently.
        return abort("reference_attachment_not_copyable", { attachment_id: meta.id, ...counts });
      }
      let full;
      try {
        full = await getFileAttachment(graph, from_list_id, task_id, meta.id);
      } catch (e) {
        return abort("attachment_read_failed", { attachment_id: meta.id, ...cause(e), ...counts });
      }
      if (!full.contentBytes) return abort("attachment_missing_bytes", { attachment_id: meta.id, ...counts });
      const bytes = bytesFromBase64(full.contentBytes);
      if (bytes.byteLength > PER_FILE_MAX_BYTES) {
        return abort("attachment_too_large", { attachment_id: meta.id, size: bytes.byteLength, max: PER_FILE_MAX_BYTES, ...counts });
      }
      try {
        await attachFile(graph, accessToken, {
          listId: to_list_id,
          taskId: newId,
          name: full.name ?? "attachment",
          bytes,
          contentType: full.contentType ?? "application/octet-stream",
          maxInlineBytes: cfg.max_inline_bytes,
        });
        attachments_copied += 1;
      } catch (e) {
        return abort("attachment_upload_failed", { attachment_id: meta.id, ...cause(e), ...counts });
      }
    }
  }

  // My Day, best-effort: read the source's CommittedDay before deleting it.
  let my_day_carried = false;
  let my_day_skipped_reason: string | undefined;
  if (myDayEnabled(ctx.env)) {
    const carry = await carryMyDay(ctx, from_list_id, to_list_id, task_id, newId);
    my_day_carried = carry.carried;
    if (!carry.carried) my_day_skipped_reason = carry.reason;
  } else {
    my_day_skipped_reason = "my_day_disabled";
  }

  // Delete the source. A failure still returns success with a warning, so the
  // caller keeps the new id and can retry the delete.
  let warning: string | undefined;
  let sourceDeleted = false;
  try {
    await graph.deleteResource(taskUrl(from_list_id, task_id));
    sourceDeleted = true;
  } catch (e) {
    const detail = e instanceof GraphError ? e.detail : String(e);
    warning = `Copied to destination (task_id: ${newId}) but source delete failed: ${detail ?? "unknown"}. Retry: delete_task({ list_id: "${from_list_id}", task_id: "${task_id}" }).`;
    log.warn("move_task_delete_failed", { from_list_id, task_id, detail });
  }

  // Moved: re-key the source's row to the copy (its stable id and My Day
  // fields follow), then refresh the Graph columns from the copy. The
  // re-keyed step rows carry the source's item ids, so mark the steps for
  // re-fetch. If the source survived, the copy is a second task with its own row.
  if (sourceDeleted) {
    await bestEffort("index_move_task_failed", { task_id }, () => ctx.index.moveTask(task_id, to_list_id, newId));
    await bestEffort("index_forget_subresources_failed", { task_id: newId }, () => ctx.index.forgetSubresources(newId));
  }
  await upsertTask(ctx, newTask, to_list_id);

  // The bare POST response had no sub-resource state; set the flags from
  // what was copied.
  await bestEffort("index_set_flags_failed", { task_id: newId }, () =>
    ctx.index.setTaskFlags(newId, { has_checklist: checklist_copied > 0, has_attachments: attachments_copied > 0 }),
  );

  return ok({
    status: "moved",
    method: "copy_delete",
    task_id: newId,
    previous_task_id: task_id,
    from_list_id,
    to_list_id,
    checklist_copied,
    linked_resources_copied,
    attachments_copied,
    my_day_carried,
    ...(my_day_skipped_reason ? { my_day_skipped_reason } : {}),
    ...(warning ? { warning } : {}),
  });
}

// The re-parent attempt, as a result the move can branch on:
//   ok                        — confirmed moved
//   !ok, attempted: false     — no PATCH sent (Substrate unavailable): no
//                               duplicate risk, go straight to the copy
//   !ok, attempted: true      — a PATCH was sent but the move isn't confirmed:
//                               re-check the source before copying
async function reparentViaSubstrate(
  ctx: OpsContext,
  toListId: string,
  taskId: string,
): Promise<{ ok: true; task: SubstrateTask } | { ok: false; attempted: boolean; reason: string; task?: SubstrateTask }> {
  try {
    const sub = await ctx.substrate();
    const task = await sub.reparentTask(toListId, taskId);
    if (isReparentConfirmed(task, toListId)) return { ok: true, task };
    // A 200 that ignored ParentFolderId. Probably not moved, but re-check.
    log.warn("move_reparent_unconfirmed", { taskId, toListId, parent: task.ParentFolderId ?? null });
    return { ok: false, attempted: true, reason: "reparent_not_confirmed", task };
  } catch (e) {
    // The token mint failed (EXO scope not consented): no PATCH went out.
    if (e instanceof Error && e.message.includes("my_day_unavailable")) {
      return { ok: false, attempted: false, reason: "my_day_unavailable" };
    }
    // The server saw a write attempt (even a 4xx): the move MAY have committed.
    if (e instanceof SubstrateError) {
      log.warn("move_reparent_substrate_error", { status: e.status, detail: e.detail });
      return { ok: false, attempted: true, reason: `substrate_${e.status}` };
    }
    // Network / timeout / dropped response — ambiguous.
    log.warn("move_reparent_failed", { error: String(e) });
    return { ok: false, attempted: true, reason: "reparent_error" };
  }
}

// Is the source still there? 404 (or the malformed-id 400) → absent; anything
// else failing → unknown, which decideAfterReparentFailure treats as moved.
async function recheckSource(graph: GraphClient, fromListId: string, taskId: string): Promise<{ sourcePresent: boolean | "unknown" }> {
  try {
    await graph.getJson(taskUrl(fromListId, taskId), TodoTaskSchema);
    return { sourcePresent: true };
  } catch (e) {
    if (isGraphNotFound(e)) return { sourcePresent: false };
    log.warn("move_recheck_source_failed", { fromListId, taskId, error: String(e) });
    return { sourcePresent: "unknown" };
  }
}

// Copy fallback: apply the source's CommittedDay to the copy. Never throws.
async function carryMyDay(
  ctx: OpsContext,
  fromListId: string,
  toListId: string,
  oldTaskId: string,
  newTaskId: string,
): Promise<{ carried: boolean; reason?: string }> {
  try {
    const sub = await ctx.substrate();
    const src = await sub.getTask(fromListId, oldTaskId);
    const day = committedDatePart(src.CommittedDay);
    if (!day) return { carried: false, reason: "source_not_in_my_day" };
    await sub.patchTask(toListId, newTaskId, { CommittedDay: day, PostponedDay: null });
    return { carried: true };
  } catch (e) {
    log.warn("move_carry_my_day_failed", { error: String(e) });
    return { carried: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

// ---- reorder ---------------------------------------------------------------

// Sets the task's manual (drag) position in its list: Substrate OrderDateTime.
// A list with an explicit sort in the To Do app doesn't show the change until
// the sort is removed.
export function reorderTask(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; position: ReorderPosition },
): Promise<ToolResult<{ list_id: string; task_id: string; task: SubstrateTask; order_datetime: string }>> {
  const { list_id, task_id, position } = input;
  return ctx.writes.run(async () => {
    const sub = await ctx.substrate();
    const computed = await computeOrder(position, {
      // The folder's OTHER tasks. Substrate lists default REST ids; translate
      // them so the mover is excluded by its immutable id too.
      neighbors: async () => {
        const folderTasks = await sub.listFolderTasks(list_id);
        const ids = await ctx.graph.translateToImmutable(folderTasks.map((t) => t.Id ?? "").filter(Boolean));
        return orderValues(folderTasks.filter((t) => t.Id !== task_id && ids.get(t.Id ?? "") !== task_id).map((t) => t.OrderDateTime));
      },
      reference: async (id) => {
        try {
          return ok((await sub.getTask(list_id, id)).OrderDateTime ?? null);
        } catch (e) {
          if (e instanceof SubstrateError && e.status === 404) return err("reference_not_in_list", { list_id, reference_task_id: id });
          throw e;
        }
      },
      noOrder: (id) =>
        err("reference_has_no_order", {
          reference_task_id: id,
          hint: "The reference task has no manual-order value; move it first (e.g. position 'top').",
        }),
    });
    if (!computed.ok) return computed;
    const task = await sub.patchTask(list_id, task_id, { OrderDateTime: computed.value });
    // Substrate is the order's only store: mirror it so it's logged and pushed.
    await bestEffort("index_update_order_failed", { task_id }, () =>
      ctx.index.updateMyDayFields(task_id, { order_datetime: computed.value }),
    );
    return ok({ list_id, task_id, task, order_datetime: computed.value });
  });
}
