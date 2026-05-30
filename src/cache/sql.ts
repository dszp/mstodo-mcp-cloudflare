// Phase 5 — SQL DDL, row types, and row⇄task mappers for the TodoIndex DO.
//
// The TodoIndex DO is the single source of truth for Microsoft To Do state:
// SQLite `tasks` (+ `tasks_fts` FTS5 mirror) + `lists` roster + `sync_state`
// (delta tokens / resume cursors). This module holds the schema DDL, the row
// types, and the Graph-object ⇄ row mappers; the DO class in index-do.ts owns
// the connection and the query logic.

import type { ChecklistItem, TodoTask, TodoTaskList } from "../graph/types";
import { stripHtml } from "../util/html";

// Singleton address for the cross-list index DO. Used everywhere via
//   env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName(OWNER_DO_NAME))
export const OWNER_DO_NAME = "owner";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
// One multi-statement block, run once on DO init (idempotent via IF NOT EXISTS).
// `tasks` has no INTEGER PRIMARY KEY, so it carries an implicit integer rowid;
// `tasks_fts` is an external-content FTS5 table keyed to that rowid, kept in
// sync by the three triggers below (the SQLite-recommended pattern). The
// `'delete'` command rows feed the old column values back so terms are removed.
export const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS tasks (
  task_id         TEXT PRIMARY KEY,
  list_id         TEXT NOT NULL,
  status          TEXT NOT NULL,
  title           TEXT NOT NULL,
  body_plain      TEXT,
  created_at      INTEGER,
  due_at          INTEGER,
  completed_at    INTEGER,
  modified_at     INTEGER,
  start_at        INTEGER,
  reminder_at     INTEGER,
  is_reminder_on  INTEGER,
  importance      TEXT,
  has_checklist   INTEGER,
  has_attachments INTEGER,
  categories_json TEXT,
  recurrence_json TEXT
);
CREATE INDEX IF NOT EXISTS tasks_list_status ON tasks(list_id, status);
CREATE INDEX IF NOT EXISTS tasks_due         ON tasks(due_at);
CREATE INDEX IF NOT EXISTS tasks_completed   ON tasks(completed_at);
CREATE INDEX IF NOT EXISTS tasks_modified    ON tasks(modified_at, task_id);

CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  title, body_plain,
  content='tasks', content_rowid='rowid',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(rowid, title, body_plain)
    VALUES (new.rowid, new.title, new.body_plain);
END;
CREATE TRIGGER IF NOT EXISTS tasks_ad AFTER DELETE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, body_plain)
    VALUES ('delete', old.rowid, old.title, old.body_plain);
END;
CREATE TRIGGER IF NOT EXISTS tasks_au AFTER UPDATE ON tasks BEGIN
  INSERT INTO tasks_fts(tasks_fts, rowid, title, body_plain)
    VALUES ('delete', old.rowid, old.title, old.body_plain);
  INSERT INTO tasks_fts(rowid, title, body_plain)
    VALUES (new.rowid, new.title, new.body_plain);
END;

CREATE TABLE IF NOT EXISTS lists (
  list_id      TEXT PRIMARY KEY,
  display_name TEXT,
  wellknown    TEXT,
  is_owner     INTEGER,
  is_shared    INTEGER
);

CREATE TABLE IF NOT EXISTS sync_state (
  resource       TEXT PRIMARY KEY,
  delta_link     TEXT,
  next_link      TEXT,
  last_synced_at INTEGER,
  status         TEXT,
  last_error     TEXT
);
`;

// Ordered column list for tasks INSERT/UPSERT — keep in lockstep with TaskRow
// and taskToRow().
export const TASK_COLUMNS = [
  "task_id",
  "list_id",
  "status",
  "title",
  "body_plain",
  "created_at",
  "due_at",
  "completed_at",
  "modified_at",
  "start_at",
  "reminder_at",
  "is_reminder_on",
  "importance",
  "has_checklist",
  "has_attachments",
  "categories_json",
  "recurrence_json",
] as const;

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------
export interface TaskRow {
  task_id: string;
  list_id: string;
  status: string;
  title: string;
  body_plain: string | null;
  created_at: number | null;
  due_at: number | null;
  completed_at: number | null;
  modified_at: number | null;
  start_at: number | null;
  reminder_at: number | null;
  is_reminder_on: number | null;
  importance: string | null;
  has_checklist: number | null;
  has_attachments: number | null;
  categories_json: string | null;
  recurrence_json: string | null;
  // Substrate-only — null until a later task's scan or write-through fills them.
  committed_day: string | null;
  committed_order: string | null;
  order_datetime: string | null;
  postponed_day: string | null;
}

export interface ListRow {
  list_id: string;
  display_name: string | null;
  wellknown: string | null;
  is_owner: number | null;
  is_shared: number | null;
}

// One row per checklist item (migration v3). Joinable to `tasks` by task_id so
// checklist text/state is queryable ACROSS tasks. created_at/checked_at are the
// Graph timestamps flattened to epoch ms (created_at drives the
// oldest-pending-first follow-up sort).
export interface ChecklistItemRow {
  item_id: string;
  task_id: string;
  list_id: string;
  display_name: string | null;
  is_checked: number;
  created_at: number | null;
  checked_at: number | null;
}

// Ordered column list for checklist_items INSERT — keep in lockstep with
// ChecklistItemRow and checklistItemToRow().
export const CHECKLIST_COLUMNS = [
  "item_id",
  "task_id",
  "list_id",
  "display_name",
  "is_checked",
  "created_at",
  "checked_at",
] as const;

export interface SubscriptionRow {
  subscription_id: string;
  list_id: string;
  client_state: string;
  expiration_ms: number;
  created_at_ms: number;
}

// QueryFilter / SyncStatusReport are consumed in Tasks 5/6; defined here so the
// row layer and the query layer share one source of truth.
export interface QueryFilter {
  lists?: string[];
  status?: string[];
  due_before?: number;
  due_after?: number;
  completed_before?: number;
  completed_after?: number;
  created_after?: number;
  importance?: string;
  has_checklist?: boolean;
  // true = task has ≥1 UNCHECKED checklist item; false = none open. Requires the
  // checklist cache (migration v3); rows are otherwise absent so false matches all.
  has_open_checklist_item?: boolean;
  limit?: number;
  cursor?: string;
}

// One matched checklist item joined with its parent task's title/status — the
// row shape searchChecklistItems returns (the agent groups by task_id).
export interface ChecklistSearchRow extends ChecklistItemRow {
  task_title: string;
  task_status: string;
}

export interface SyncStatusReport {
  resource: string;
  status: string | null;
  last_synced_at: number | null;
  mid_cycle: boolean;
  last_error: string | null;
  row_count: number;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------
function isoToEpoch(s: string | null | undefined): number | null {
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

// Graph dateTimeTimeZone → epoch ms. To Do emits these in UTC with a separate
// `timeZone` field and over-long (7-digit) fractional seconds; truncate to ms
// and append a UTC designator when the value carries no offset.
function dtzToEpoch(
  dtz: { dateTime?: string; timeZone?: string } | null | undefined,
): number | null {
  if (!dtz?.dateTime) return null;
  let s = dtz.dateTime.trim().replace(/(\.\d{3})\d+/, "$1");
  if (!/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) s += "Z";
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : ms;
}

export function epochToIso(n: number | null): string | undefined {
  return n == null ? undefined : new Date(n).toISOString();
}

function boolTo01(b: boolean | undefined): number | null {
  return b === undefined ? null : b ? 1 : 0;
}

// Graph TodoTask → tasks row. Delta objects lack expansions, so has_checklist
// is only known when checklistItems is present (e.g. a mutation result);
// otherwise null. status/title default to satisfy the NOT NULL columns (Graph
// always supplies them for real tasks).
export function taskToRow(t: TodoTask, listId: string): TaskRow {
  return {
    task_id: t.id,
    list_id: listId,
    status: t.status ?? "notStarted",
    title: t.title ?? "",
    body_plain:
      t.body?.content == null ? null : stripHtml(t.body.content, t.body.contentType),
    created_at: isoToEpoch(t.createdDateTime),
    due_at: dtzToEpoch(t.dueDateTime),
    completed_at: dtzToEpoch(t.completedDateTime),
    modified_at: isoToEpoch(t.lastModifiedDateTime),
    start_at: dtzToEpoch(t.startDateTime),
    reminder_at: dtzToEpoch(t.reminderDateTime),
    is_reminder_on: boolTo01(t.isReminderOn),
    importance: t.importance ?? null,
    has_checklist:
      t.checklistItems === undefined ? null : t.checklistItems.length > 0 ? 1 : 0,
    has_attachments: boolTo01(t.hasAttachments),
    categories_json:
      t.categories && t.categories.length > 0 ? JSON.stringify(t.categories) : null,
    recurrence_json: t.recurrence ? JSON.stringify(t.recurrence) : null,
    // Substrate-only fields: Graph delta has no source for them, so a Graph
    // upsert always writes null here. They're excluded from TASK_COLUMNS, so
    // the real UPSERT never references them — but TaskRow requires them.
    committed_day: null,
    committed_order: null,
    order_datetime: null,
    postponed_day: null,
  };
}

// Graph checklistItem → checklist_items row. isChecked defaults to false (the
// NOT NULL is_checked column); createdDateTime/checkedDateTime flatten to epoch.
export function checklistItemToRow(
  item: ChecklistItem,
  taskId: string,
  listId: string,
): ChecklistItemRow {
  return {
    item_id: item.id,
    task_id: taskId,
    list_id: listId,
    display_name: item.displayName ?? null,
    is_checked: item.isChecked ? 1 : 0,
    created_at: isoToEpoch(item.createdDateTime),
    checked_at: isoToEpoch(item.checkedDateTime),
  };
}

export function listToRow(l: TodoTaskList): ListRow {
  return {
    list_id: l.id,
    display_name: l.displayName ?? null,
    wellknown: l.wellknownListName ?? null,
    is_owner: boolTo01(l.isOwner),
    is_shared: boolTo01(l.isShared),
  };
}

// Roster row → Graph-shaped list, so DO-served list_lists/get_list keep the same
// public shape the live-Graph path produced.
export function rowToList(r: ListRow): TodoTaskList {
  return {
    id: r.list_id,
    displayName: r.display_name ?? "",
    isOwner: r.is_owner == null ? undefined : !!r.is_owner,
    isShared: r.is_shared == null ? undefined : !!r.is_shared,
    wellknownListName: r.wellknown ?? undefined,
  };
}

// Row → list_tasks/query_tasks summary. Mirrors the agent's summarizeTask shape
// (ISO date strings, booleans) so the DO-served tools keep the same envelope.
export function rowToSummary(r: TaskRow) {
  return {
    id: r.task_id,
    list_id: r.list_id,
    title: r.title,
    status: r.status,
    importance: r.importance ?? undefined,
    isReminderOn: r.is_reminder_on == null ? undefined : !!r.is_reminder_on,
    hasAttachments: r.has_attachments == null ? undefined : !!r.has_attachments,
    hasChecklist: r.has_checklist == null ? undefined : !!r.has_checklist,
    createdDateTime: epochToIso(r.created_at),
    lastModifiedDateTime: epochToIso(r.modified_at),
    dueDateTime: epochToIso(r.due_at),
    completedDateTime: epochToIso(r.completed_at),
    startDateTime: epochToIso(r.start_at),
    reminderDateTime: epochToIso(r.reminder_at),
    categories: r.categories_json
      ? (JSON.parse(r.categories_json) as string[])
      : undefined,
    committedDay: r.committed_day ?? undefined,
    committedOrder: r.committed_order ?? undefined,
    orderDateTime: r.order_datetime ?? undefined,
    postponedDay: r.postponed_day ?? undefined,
  };
}
