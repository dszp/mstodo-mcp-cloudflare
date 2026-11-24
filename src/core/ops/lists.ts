import { GraphError } from "../graph/client";
import { TodoTaskListSchema, type TodoTaskList } from "../graph/types";
import { bestEffort, isGraphNotFound, reserveSid, type OpsContext } from "./context";
import { err, ok, type ToolResult } from "./result";

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
