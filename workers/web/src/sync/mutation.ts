// The shapes of SYNC-API §5: what the app sends to POST /api/v1/sync/mutations
// and what comes back. The outbox, the overlay and the edit helpers share them.

// Every op in the §5.2 table.
export type Op =
  | "list.create"
  | "list.update"
  | "list.delete"
  | "list.reorder"
  | "list_group.create"
  | "list_group.update"
  | "list_group.reorder"
  | "list_group.delete"
  | "task.create"
  | "task.update"
  | "task.delete"
  | "task.move"
  | "task.reorder"
  | "myday.add"
  | "myday.remove"
  | "myday.reorder"
  | "step.create"
  | "step.update"
  | "step.delete"
  | "step.reorder"
  | "link.create"
  | "link.update"
  | "link.delete"
  | "attachment.delete"
  | "theme_image.delete"
  | "settings.update";

// §5.2: a neighbor by sid, or one end of the container. The server turns it into
// an order value, so To Do's order encoding never reaches the app.
export type Position = { before: string } | { after: string } | { top: true } | { bottom: true };

// One edit. `id` is made once and kept across every retry (§5.4); `at` is the
// device time of the edit, used for conflicts (§6).
export interface Mutation {
  id: string;
  at: string;
  op: Op;
  sid: string;
  fields?: Record<string, unknown>;
  position?: Position;
}

// §5.3, one result per mutation.
export type MutationResult =
  | { id: string; status: "applied"; sid?: string; superseded_fields?: string[] }
  | { id: string; status: "duplicate"; sid?: string; superseded_fields?: string[] }
  | { id: string; status: "rejected"; error: string }
  | { id: string; status: "failed"; error: string; retry: boolean }
  | { id: string; status: "skipped" };

// The §5.3 response body. A send that gets no body (network failure, 5xx, or a
// signed-out session) throws instead of returning.
export interface SendResult {
  cursor: string;
  results: MutationResult[];
}
