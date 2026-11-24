import { GraphError } from "../graph/client";
import { TodoTaskListSchema, type TodoTaskList } from "../graph/types";
import { bestEffort, isGraphNotFound, reserveSid, type OpsContext } from "./context";
import { err, ok, type ToolResult } from "./result";
import { loadListsConfig, storeListsConfig } from "../config/loader";
import { withListSync, type ListSync } from "../config/sync-policy";

// list.create / list.update / list.delete (docs/SYNC-API.md section 5.2).

const LISTS_URL = "https://graph.microsoft.com/v1.0/me/todo/lists";
const listUrl = (listId: string) => `${LISTS_URL}/${encodeURIComponent(listId)}`;

const upsertList = (ctx: OpsContext, list: TodoTaskList) =>
  bestEffort("index_upsert_list_failed", { list_id: list.id }, () => ctx.index.upsertList(list));

// `sid`: the sync API's sid for the new list (see reserveSid).
export function createList(ctx: OpsContext, input: { display_name: string; sid?: string }): Promise<ToolResult<{ list: TodoTaskList }>> {
  return ctx.writes.run(async () => {
    const list = await ctx.graph.postJson(LISTS_URL, { displayName: input.display_name }, TodoTaskListSchema);
    await reserveSid(ctx, "list", input.sid, list.id);
    await upsertList(ctx, list);
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
// applies it at once: an excluded list's tasks leave the feed as deletion
// records, and a list switched back on is baselined again.
export function setListSync(
  ctx: OpsContext,
  input: { list_id: string; sync: ListSync },
): Promise<ToolResult<{ list_id: string; sync: ListSync }>> {
  return ctx.writes.run(async () => {
    const cfg = await loadListsConfig(ctx.env);
    await storeListsConfig(ctx.env, withListSync(cfg, input.list_id, input.sync));
    await ctx.index.refreshListSync();
    return ok({ list_id: input.list_id, sync: input.sync });
  });
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
