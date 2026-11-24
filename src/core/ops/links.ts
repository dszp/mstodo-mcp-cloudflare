import { LinkedResourceSchema, type LinkedResource } from "../graph/types";
import { createLinkedResource } from "../graph/todo-resources";
import { checklistCacheEnabled } from "../checklist/gate";
import { bestEffort, isGraphNotFound, type OpsContext } from "./context";
import { err, ok, type ToolResult } from "./result";

// link.create / link.update / link.delete (docs/SYNC-API.md section 5.2). To Do
// allows one linked resource per task. The index write-throughs keep a just-
// written link addressable by its sid; the per-task sub-resource scan, which
// runs only with the checklist cache on (the same gate as here), stays the
// authority.

const linkUrl = (listId: string, taskId: string, resourceId: string) =>
  `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/linkedResources/${encodeURIComponent(resourceId)}`;

async function cacheUpsert(ctx: OpsContext, taskId: string, listId: string, link: LinkedResource): Promise<void> {
  if (!checklistCacheEnabled(ctx.env)) return;
  await bestEffort("index_upsert_linked_resource_failed", { task_id: taskId }, () =>
    ctx.index.upsertLinkedResource(taskId, listId, link),
  );
}

export type LinkResult = { list_id: string; task_id: string; linked_resource: LinkedResource };

export function createLink(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; application_name: string; display_name?: string; external_id?: string; web_url?: string },
): Promise<ToolResult<LinkResult>> {
  const { list_id, task_id } = input;
  return ctx.writes.run(async () => {
    try {
      const linked_resource = await createLinkedResource(ctx.graph, list_id, task_id, {
        applicationName: input.application_name,
        displayName: input.display_name,
        externalId: input.external_id,
        webUrl: input.web_url,
      });
      await cacheUpsert(ctx, task_id, list_id, linked_resource);
      return ok({ list_id, task_id, linked_resource });
    } catch (e) {
      if (isGraphNotFound(e)) return err("task_not_found", { list_id, task_id });
      throw e;
    }
  });
}

// Only supplied fields change; null clears external_id / web_url.
export function updateLink(
  ctx: OpsContext,
  input: {
    list_id: string;
    task_id: string;
    resource_id: string;
    application_name?: string;
    display_name?: string;
    external_id?: string | null;
    web_url?: string | null;
  },
): Promise<ToolResult<LinkResult>> {
  const { list_id, task_id, resource_id } = input;
  const body: Record<string, unknown> = {};
  if (input.application_name !== undefined) body.applicationName = input.application_name;
  if (input.display_name !== undefined) body.displayName = input.display_name;
  if (input.external_id !== undefined) body.externalId = input.external_id;
  if (input.web_url !== undefined) body.webUrl = input.web_url;
  return ctx.writes.run(async () => {
    try {
      const linked_resource = await ctx.graph.patchJson(linkUrl(list_id, task_id, resource_id), body, LinkedResourceSchema);
      await cacheUpsert(ctx, task_id, list_id, linked_resource);
      return ok({ list_id, task_id, linked_resource });
    } catch (e) {
      if (isGraphNotFound(e)) return err("linked_resource_not_found", { list_id, task_id, resource_id });
      throw e;
    }
  });
}

export function deleteLink(
  ctx: OpsContext,
  input: { list_id: string; task_id: string; resource_id: string },
): Promise<ToolResult<{ list_id: string; task_id: string; resource_id: string }>> {
  const { list_id, task_id, resource_id } = input;
  return ctx.writes.run(async () => {
    try {
      await ctx.graph.deleteResource(linkUrl(list_id, task_id, resource_id));
      if (checklistCacheEnabled(ctx.env)) {
        await bestEffort("index_delete_linked_resource_failed", { task_id }, () => ctx.index.deleteLinkedResource(task_id, resource_id));
      }
      return ok({ list_id, task_id, resource_id });
    } catch (e) {
      if (isGraphNotFound(e)) return err("linked_resource_not_found", { list_id, task_id, resource_id });
      throw e;
    }
  });
}
