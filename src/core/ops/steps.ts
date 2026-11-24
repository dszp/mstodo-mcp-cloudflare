import { compareOrderDateTimeDesc } from "../graph/substrate-client";
import { ChecklistItemSchema, type ChecklistItem } from "../graph/types";
import { createChecklistItem, listChecklistItems } from "../graph/todo-resources";
import { bestEffort, isGraphNotFound, type OpsContext } from "./context";
import { computeOrder, orderValues, type ReorderPosition } from "./position";
import { err, ok, type ToolResult } from "./result";

// step.create / step.update / step.delete / step.reorder (docs/SYNC-API.md
// section 5.2). A step is a Graph checklistItem; its manual order is
// Substrate-only (OrderDateTime on the subtask), so step.reorder needs My Day.

const itemUrl = (listId: string, taskId: string, itemId: string) =>
  `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/checklistItems/${encodeURIComponent(itemId)}`;

// Checklist write-throughs, made with the cache on or off. With it on they're
// latency only (the edit rides delta and the scan re-fetches). With it off
// they're the only rows a step gets, and they're how a step written here has
// a sid the sync API can edit by; nothing re-fetches them, so a step changed
// elsewhere can go stale (/sync/info reports sub_resources: false).
async function cacheUpsert(ctx: OpsContext, taskId: string, listId: string, item: ChecklistItem): Promise<void> {
  await bestEffort("index_upsert_checklist_item_failed", { task_id: taskId }, () =>
    ctx.index.upsertChecklistItem(taskId, listId, item),
  );
}

export type StepResult = { list_id: string; task_id: string; item: ChecklistItem };

export function createStep(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; display_name: string; is_checked?: boolean },
): Promise<ToolResult<StepResult>> {
  const { list_id, task_id } = input;
  return ctx.writes.run(async () => {
    try {
      const item = await createChecklistItem(ctx.graph, list_id, task_id, {
        displayName: input.display_name,
        isChecked: input.is_checked,
      });
      await bestEffort("index_set_flags_failed", { task_id }, () => ctx.index.setTaskFlags(task_id, { has_checklist: true }));
      await cacheUpsert(ctx, task_id, list_id, item);
      return ok({ list_id, task_id, item });
    } catch (e) {
      if (isGraphNotFound(e)) return err("task_not_found", { list_id, task_id });
      throw e;
    }
  });
}

// Steps on the task titled `title` and created at or after `since_ms`: what an
// earlier create attempt that lost its response may have made (section 5.4).
// A single match is written through, so the caller can adopt it.
export async function findCreatedSteps(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; title: string; since_ms: number },
): Promise<ChecklistItem[]> {
  const items = await listChecklistItems(ctx.graph, input.list_id, input.task_id);
  const found = items.filter(
    (i) => i.displayName === input.title && !!i.createdDateTime && Date.parse(i.createdDateTime) >= input.since_ms - 5_000,
  );
  if (found.length === 1) await cacheUpsert(ctx, input.task_id, input.list_id, found[0]);
  return found;
}

export function updateStep(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; item_id: string; display_name?: string; is_checked?: boolean },
): Promise<ToolResult<StepResult>> {
  const { list_id, task_id, item_id } = input;
  const body: Record<string, unknown> = {};
  if (input.display_name !== undefined) body.displayName = input.display_name;
  if (input.is_checked !== undefined) body.isChecked = input.is_checked;
  return ctx.writes.run(async () => {
    try {
      const item = await ctx.graph.patchJson(itemUrl(list_id, task_id, item_id), body, ChecklistItemSchema);
      // has_checklist is unaffected by an update.
      await cacheUpsert(ctx, task_id, list_id, item);
      return ok({ list_id, task_id, item });
    } catch (e) {
      if (isGraphNotFound(e)) return err("checklist_item_not_found", { list_id, task_id, item_id });
      throw e;
    }
  });
}

export function deleteStep(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; item_id: string },
): Promise<ToolResult<{ list_id: string; task_id: string; item_id: string }>> {
  const { list_id, task_id, item_id } = input;
  return ctx.writes.run(async () => {
    try {
      await ctx.graph.deleteResource(itemUrl(list_id, task_id, item_id));
      // has_checklist is left as-is (whether this was the last item is unknown
      // without a re-list); the next delta-driven re-fetch reconciles.
      await bestEffort("index_delete_checklist_item_failed", { task_id }, () => ctx.index.deleteChecklistItem(task_id, item_id));
      return ok({ list_id, task_id, item_id });
    } catch (e) {
      if (isGraphNotFound(e)) return err("checklist_item_not_found", { list_id, task_id, item_id });
      throw e;
    }
  });
}

export type OrderedStep = {
  item_id: string | null;
  display_name: string | null;
  order_datetime: string | null;
  is_checked: boolean | null;
};

// Sets the step's Substrate OrderDateTime. Neighbors and the reference come
// from one read of the task's steps (inline on the folder-scoped task GET, so
// the list is required here even though the PATCH itself is folder-free).
// Returns every step in its new order.
export function reorderStep(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; item_id: string; position: ReorderPosition },
): Promise<ToolResult<{ list_id: string; task_id: string; item_id: string; order_datetime: string; ordered_items: OrderedStep[] }>> {
  const { list_id, task_id, item_id, position } = input;
  return ctx.writes.run(async () => {
    const sub = await ctx.substrate();
    // Full 429 budget — this is a write.
    const subtasks = await sub.listSubtasks(list_id, task_id);
    const computed = await computeOrder(position, {
      neighbors: () => orderValues(subtasks.filter((s) => s.Id !== item_id).map((s) => s.OrderDateTime)),
      reference: async (id) => {
        const ref = subtasks.find((s) => s.Id === id);
        if (!ref) return err("reference_not_found", { task_id, reference_item_id: id });
        return ok(ref.OrderDateTime ?? null);
      },
      noOrder: (id) =>
        err("reference_has_no_order", {
          reference_item_id: id,
          hint: "The reference item has no manual-order value; move it first (e.g. position 'top').",
        }),
    });
    if (!computed.ok) return computed;
    const newOrder = computed.value;

    await sub.patchSubtask(task_id, item_id, { OrderDateTime: newOrder });

    // The new order without a second read: apply newOrder to the moved step
    // locally. Descending OrderDateTime, nulls last.
    const ordered_items = subtasks
      .map((s) => ({
        item_id: s.Id ?? null,
        display_name: s.Subject ?? null,
        order_datetime: s.Id === item_id ? newOrder : (s.OrderDateTime ?? null),
        is_checked: s.IsCompleted ?? null,
      }))
      .sort((a, b) => compareOrderDateTimeDesc(a.order_datetime, b.order_datetime));
    return ok({ list_id, task_id, item_id, order_datetime: newOrder, ordered_items });
  });
}
