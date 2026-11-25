import { GraphError } from "../graph/client";
import { SubstrateError } from "../graph/substrate-client";
import { TodoTaskListSchema, type TodoTaskList } from "../graph/types";
import { bestEffort, isGraphNotFound, reserveSid, type OpsContext } from "./context";
import { err, ok, type ToolResult } from "./result";
import { computeOrder, orderValues } from "./position";
import type { ListSync } from "../config/sync-policy";

// list.create / list.update / list.delete (docs/SYNC-API.md section 5.2).

const LISTS_URL = "https://graph.microsoft.com/v1.0/me/todo/lists";
const listUrl = (listId: string) => `${LISTS_URL}/${encodeURIComponent(listId)}`;

const upsertList = (ctx: OpsContext, list: TodoTaskList) =>
  bestEffort("index_upsert_list_failed", { list_id: list.id }, () => ctx.index.upsertList(list));

// A list made here is meant to be used, so it is pinned todo (section 1.2).
// Unpinned, its sync setting would come from name patterns, and a name that
// matches an excluded pattern would purge the new list on the next cycle.
const pinTodo = (ctx: OpsContext, list: TodoTaskList) =>
  bestEffort("list_pin_failed", { list_id: list.id }, () => ctx.index.updateListsConfig({ overrides: { [list.id]: "todo" } }));

// `sid`: the sync API's sid for the new list (see reserveSid).
export function createList(ctx: OpsContext, input: { display_name: string; sid?: string }): Promise<ToolResult<{ list: TodoTaskList }>> {
  return ctx.writes.run(async () => {
    const list = await ctx.graph.postJson(LISTS_URL, { displayName: input.display_name }, TodoTaskListSchema);
    await reserveSid(ctx, "list", input.sid, list.id);
    await upsertList(ctx, list);
    await pinTodo(ctx, list);
    return ok({ list });
  });
}

// Ambiguous-create recovery (docs/SYNC-API.md section 5.4): a list.create
// whose earlier attempt may have reached Graph looks for what it made before
// creating again. Lists carry no creation time or free field, so a candidate
// is a list with the same name that the mirror first saw after the attempt
// began (minus skew), or hasn't seen yet, and that no other mutation's sid
// already names. One candidate is adopted under the app's sid; more than one
// is for the caller to refuse.
const CREATE_SKEW_MS = 5_000;
export async function findCreatedLists(
  ctx: OpsContext,
  input: { display_name: string; since_ms: number; sid?: string },
): Promise<TodoTaskList[]> {
  const res = await ctx.graph.getAllPages(LISTS_URL, TodoTaskListSchema);
  const named = res.status === 200 ? (res.items as TodoTaskList[]).filter((l) => l.displayName === input.display_name) : [];
  if (named.length === 0) return [];
  const seen = await ctx.index.createCandidates("list", named.map((l) => l.id));
  const found = named.filter((l) => {
    const c = seen[l.id];
    return c === undefined || (!c.app_owned && c.first_seen_ms >= input.since_ms - CREATE_SKEW_MS);
  });
  if (found.length === 1) {
    await reserveSid(ctx, "list", input.sid, found[0].id);
    await upsertList(ctx, found[0]);
    await pinTodo(ctx, found[0]);
  }
  return found;
}

export function updateList(
  ctx: OpsContext,
  input: { list_id: string; display_name: string },
): Promise<ToolResult<{ list: TodoTaskList }>> {
  const { list_id } = input;
  return ctx.writes.run(async () => {
    try {
      const list = await ctx.graph.patchJson(listUrl(list_id), { displayName: input.display_name }, TodoTaskListSchema);
      await upsertList(ctx, list);
      return ok({ list });
    } catch (e) {
      if (isGraphNotFound(e)) return err("list_not_found", { list_id });
      throw e;
    }
  });
}

// A list's sync setting (docs/SYNC-API.md section 1.2). It lives in
// config:lists, not in Microsoft To Do, so nothing goes to Graph. The index
// writes it and applies it at once: an excluded list's tasks leave the feed
// as deletion records, and a list switched back on is baselined again.
export function setListSync(
  ctx: OpsContext,
  input: { list_id: string; sync: ListSync },
): Promise<ToolResult<{ list_id: string; sync: ListSync }>> {
  return ctx.writes.run(async () => {
    await ctx.index.updateListsConfig({ overrides: { [input.list_id]: input.sync } });
    return ok({ list_id: input.list_id, sync: input.sync });
  });
}

// A list's sidebar appearance (docs/SYNC-API.md section 10.4): its theme and
// its group. Graph has neither, so the write goes to Substrate's task folder,
// and the mirror stores the folder as Substrate returns it. Theme values are
// To Do's preset names. `group_id` is a Substrate group Id, or null to take
// the list out of its group. The caller has checked ENABLE_MY_DAY.
export function setListAppearance(
  ctx: OpsContext,
  input: { list_id: string; theme?: { color?: string; background?: string }; group_id?: string | null },
): Promise<ToolResult<{ list_id: string }>> {
  const body: Record<string, unknown> = {};
  if (input.theme?.color !== undefined) body.ThemeColor = input.theme.color;
  if (input.theme?.background !== undefined) body.ThemeBackground = input.theme.background;
  if (input.group_id !== undefined) body.ParentFolderGroupId = input.group_id;
  return ctx.writes.run(async () => {
    if (input.group_id !== undefined) {
      const self = (await ctx.index.sidebar()).lists.find((l) => l.list_id === input.list_id);
      // To Do keeps the default list at the top with the smart lists.
      if (self?.wellknown === "defaultList") return err("default_list", { list_id: input.list_id });
    }
    return patchFolder(ctx, input.list_id, body);
  });
}

// Where a list sits in the sidebar. Groups and top-level lists share one
// ordering, and a group's lists are ordered within it, so the reference must
// be in the list's own container: a list in the same group, or, for a
// top-level list, another top-level list or a group. A later order value is
// nearer the top, as for tasks. `reference_id` is a list's Graph ID or a
// group's Substrate Id.
export function reorderList(
  ctx: OpsContext,
  input: { list_id: string; position: { kind: "top" | "bottom" } | { kind: "before" | "after"; reference_id: string } },
): Promise<ToolResult<{ list_id: string }>> {
  const { list_id, position } = input;
  return ctx.writes.run(async () => {
    const { lists, groups } = await ctx.index.sidebar();
    const self = lists.find((l) => l.list_id === list_id);
    if (!self) return err("list_not_found", { list_id });
    if (self.wellknown === "defaultList") return err("default_list", { list_id });
    const siblings: Array<{ id: string; order: string | null }> = [
      ...lists
        .filter((l) => l.list_id !== list_id && l.group_id === self.group_id && l.wellknown !== "defaultList")
        .map((l) => ({ id: l.list_id, order: l.order_datetime })),
      ...(self.group_id === null ? groups.map((g) => ({ id: g.group_id, order: g.order_datetime })) : []),
    ];
    const order = await computeOrder(position, {
      neighbors: () => orderValues(siblings.map((s) => s.order)),
      reference: async (id) => {
        const ref = siblings.find((s) => s.id === id);
        return ref ? ok(ref.order) : err("reference_not_sibling", { reference_id: id });
      },
      noOrder: (id) => err("reference_has_no_order", { reference_id: id }),
    });
    if (!order.ok) return order;
    const whole = wholeSecondOrder(order.value, orderValues(siblings.map((s) => s.order)));
    if (whole === null) {
      return err("order_precision_exhausted", { hint: "No whole second between the neighbors; move a neighbor first, or use top or bottom." });
    }
    return patchFolder(ctx, list_id, { OrderDateTime: whole });
  });
}

// Substrate keeps a list's OrderDateTime to the second (it stored
// …46:49.248Z as …46:49Z on 2026-11-25), so a value between two neighbors a
// second apart could land on one of them. The computed value is rounded down,
// or else up, to a whole second that keeps its place among the siblings: the
// same count above it, and no tie. Null when neither does.
export function wholeSecondOrder(order: string, siblings: number[]): string | null {
  const ms = Date.parse(order);
  const above = (v: number) => siblings.filter((s) => s > v).length;
  const want = above(ms);
  for (const v of [Math.floor(ms / 1000) * 1000, Math.ceil(ms / 1000) * 1000]) {
    if (above(v) === want && !siblings.includes(v)) return new Date(v).toISOString().replace(".000Z", "Z");
  }
  return null;
}

async function patchFolder(ctx: OpsContext, list_id: string, body: Record<string, unknown>): Promise<ToolResult<{ list_id: string }>> {
  const sub = await ctx.substrate();
  try {
    const folder = await sub.patchFolder(list_id, body);
    await bestEffort("index_store_folder_failed", { list_id }, () => ctx.index.storeFolderAppearance(folder));
    return ok({ list_id });
  } catch (e) {
    if (e instanceof SubstrateError && e.status === 404) return err("list_not_found", { list_id });
    // A refusal here says nothing about My Day, so it isn't left to the
    // caller's 403 handling, which would turn My Day off.
    if (e instanceof SubstrateError && e.status === 403) return err("list_appearance_unavailable", { list_id });
    throw e;
  }
}

export function deleteList(ctx: OpsContext, input: { list_id: string }): Promise<ToolResult<{ list_id: string }>> {
  const { list_id } = input;
  return ctx.writes.run(async () => {
    try {
      await ctx.graph.deleteResource(listUrl(list_id));
      await bestEffort("index_delete_list_failed", { list_id }, () => ctx.index.deleteList(list_id));
      return ok({ list_id });
    } catch (e) {
      if (isGraphNotFound(e)) return err("list_not_found", { list_id });
      if (e instanceof GraphError && e.status === 405) {
        return err("method_not_allowed", {
          list_id,
          hint: "The default list (wellknownListName: 'defaultList') cannot be deleted.",
        });
      }
      throw e;
    }
  });
}
