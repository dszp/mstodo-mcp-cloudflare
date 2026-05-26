import { z } from "zod";
import type { GraphClient } from "./client";
import {
  AttachmentSchema,
  ChecklistItemSchema,
  LinkedResourceSchema,
  TaskFileAttachmentSchema,
  type Attachment,
  type ChecklistItem,
  type LinkedResource,
  type TaskFileAttachment,
} from "./types";

// Thin, reusable Graph operations on a To Do task's sub-resources. Both the
// standalone MCP tools (create_checklist_item, create_linked_resource,
// list_attachments, get_attachment) and move_task's copy/delete fallback go
// through these, so the URL shapes, request bodies, and response schemas live
// in exactly one place. These are the raw Graph calls only — callers keep their
// own error mapping (404 → task_not_found, etc.) and MCP response shaping.

const taskUrl = (listId: string, taskId: string) =>
  `https://graph.microsoft.com/v1.0/me/todo/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`;

const AttachmentCollectionSchema = z
  .object({ value: z.array(AttachmentSchema) })
  .passthrough();

export function createChecklistItem(
  graph: GraphClient,
  listId: string,
  taskId: string,
  fields: { displayName: string; isChecked?: boolean },
): Promise<ChecklistItem> {
  const body: Record<string, unknown> = { displayName: fields.displayName };
  if (fields.isChecked !== undefined) body.isChecked = fields.isChecked;
  return graph.postJson(`${taskUrl(listId, taskId)}/checklistItems`, body, ChecklistItemSchema);
}

export function createLinkedResource(
  graph: GraphClient,
  listId: string,
  taskId: string,
  fields: {
    applicationName: string;
    displayName?: string;
    externalId?: string;
    webUrl?: string;
  },
): Promise<LinkedResource> {
  const body: Record<string, unknown> = { applicationName: fields.applicationName };
  if (fields.displayName !== undefined) body.displayName = fields.displayName;
  if (fields.externalId !== undefined) body.externalId = fields.externalId;
  if (fields.webUrl !== undefined) body.webUrl = fields.webUrl;
  return graph.postJson(`${taskUrl(listId, taskId)}/linkedResources`, body, LinkedResourceSchema);
}

// Enumerate the attachments COLLECTION. Note: `$expand=attachments` is silently
// ignored on a todoTask (no array is returned), so this explicit list is the
// only reliable way to discover a task's attachments.
export async function listAttachments(
  graph: GraphClient,
  listId: string,
  taskId: string,
): Promise<Attachment[]> {
  const res = await graph.getJson(`${taskUrl(listId, taskId)}/attachments`, AttachmentCollectionSchema);
  return res.value;
}

// Fetch one file attachment including base64 contentBytes (for byte round-trip).
export function getFileAttachment(
  graph: GraphClient,
  listId: string,
  taskId: string,
  attachmentId: string,
): Promise<TaskFileAttachment> {
  return graph.getJson(
    `${taskUrl(listId, taskId)}/attachments/${encodeURIComponent(attachmentId)}`,
    TaskFileAttachmentSchema,
  );
}
