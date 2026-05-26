import type { TodoTask } from "../graph/types";

// Pure helpers for the move_task handler. Extracted so the branching logic can
// be unit-tested without standing up the full MCP agent (the repo tests pure
// units + the Substrate/Graph clients; handler orchestration is covered by the
// live smoke in PLAN-MOVE-TASK.md's verification step). See agent.ts move_task.

// Build the POST body for the copy/delete fallback's create-in-destination
// step. Copies only writable scalar fields that are present; excludes
// server-managed fields (id, *DateTime stamps, hasAttachments) and the
// sub-resource collections (checklistItems / linkedResources / attachments),
// which Graph does not accept in a task POST and are copied individually.
export function buildMoveCopyBody(src: TodoTask): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (src.title) body.title = src.title;
  if (src.body) body.body = src.body;
  if (src.dueDateTime) body.dueDateTime = src.dueDateTime;
  if (src.reminderDateTime) body.reminderDateTime = src.reminderDateTime;
  if (src.startDateTime) body.startDateTime = src.startDateTime;
  if (src.completedDateTime) body.completedDateTime = src.completedDateTime;
  if (src.importance) body.importance = src.importance;
  if (src.status) body.status = src.status;
  if (src.isReminderOn !== undefined) body.isReminderOn = src.isReminderOn;
  if (src.categories?.length) body.categories = src.categories;
  if (src.recurrence) body.recurrence = src.recurrence;
  return body;
}

// Confirm the Substrate re-parent actually moved the task. The PATCH response
// echoes ParentFolderId; if it doesn't equal the destination list, the move
// didn't take (a silent no-op 200 that ignored ParentFolderId), so the caller
// must route through the duplicate-creation guard rather than trust it.
export function isReparentConfirmed(
  response: { ParentFolderId?: string | null },
  toListId: string,
): boolean {
  return response.ParentFolderId === toListId;
}

// Duplicate-creation guard. Runs only after a Substrate re-parent was ATTEMPTED
// but did not confirm (error, dropped response, or non-matching ParentFolderId).
// A re-parent that committed at EWS but lost its response leaves the source
// already gone — blindly falling back would create a SECOND copy in the
// destination. So fall back to create/delete only when the source is *confirmed
// still present*; otherwise treat the move as already done (the handler then
// best-effort reconciles the cache and returns success). An unknown source
// state (the re-check itself failed) is treated conservatively as already-moved
// so we never risk a duplicate.
export function decideAfterReparentFailure(state: {
  sourcePresent: boolean | "unknown";
}): "fallback_copy" | "treat_as_moved" {
  return state.sourcePresent === true ? "fallback_copy" : "treat_as_moved";
}
