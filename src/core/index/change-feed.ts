// The read side of the client sync API (docs/SYNC-API.md sections 4 and 18.3):
// turns the change log (sync_log, migration v5) into pages of entities keyed
// by server IDs (sids). Pure functions over SqlDb, so both hosts share them;
// IndexCore exposes them over RPC.
//
// Cursor: "<epoch>.<seq>". The epoch changes when every client must start over
// (resetIdentity, a restore); a cursor from another epoch, or one ahead of the
// log (a restored database), is refused so the client does a full sync.

import type { SqlDb, SqlValue } from "../ports";

export type FeedScope = "active" | "all";

// How long a completed task stays in the `active` scope.
export const ACTIVE_COMPLETED_WINDOW_MS = 30 * 86_400_000;
export const DEFAULT_PAGE_LIMIT = 500;
export const MAX_PAGE_LIMIT = 1000;
// A page also stops at about this much JSON, because task bodies vary in size.
export const PAGE_BYTE_BUDGET = 1_000_000;

export interface FeedStep {
  id: string;
  title: string | null;
  checked: boolean;
  checked_at: string | null;
  created_at: string | null;
  order: string | null;
}
export interface FeedLink {
  id: string;
  url: string | null;
  title: string | null;
  app: string | null;
  external_id: string | null;
}
export interface FeedAttachment {
  id: string;
  name: string | null;
  size: number | null;
  content_type: string | null;
}
export interface FeedTask {
  list_id: string | null;
  title: string;
  status: string;
  body: { type: string; content: string } | null;
  importance: string | null;
  categories: string[];
  due: string | null;
  start: string | null;
  reminder: { on: boolean; at: string | null };
  completed_at: string | null;
  recurrence: unknown;
  created_at: string | null;
  modified_at: string | null;
  order: string | null;
  my_day: { committed_day: string | null; committed_order: string | null; postponed_day: string | null };
  // false until the per-task sub-resource scan has fetched steps, links and
  // attachment details for this task (section 1.1).
  subresources_complete: boolean;
  steps: FeedStep[];
  links: FeedLink[];
  attachments: FeedAttachment[];
}
export interface FeedList {
  name: string | null;
  wellknown: string | null;
  is_owner: boolean | null;
  is_shared: boolean | null;
  // Sidebar groups and order come from Substrate (section 10.4); not mirrored yet.
  group_id: null;
  sort_key: null;
}
export type FeedChange =
  | { kind: "task"; id: string; seq: number; deleted: false; data: FeedTask; field_clock: Record<string, number> }
  | { kind: "list"; id: string; seq: number; deleted: false; data: FeedList }
  | { kind: "task" | "list"; id: string; seq: number; deleted: true };

export interface FeedPage {
  cursor: string;
  has_more: boolean;
  changes: FeedChange[];
  backfill: { remaining: number };
}
export type FeedResult =
  | { ok: true; page: FeedPage }
  | { ok: false; error: "cursor_reset" | "cursor_expired" | "bad_cursor" | "bad_scope" };

export function readEpoch(sql: SqlDb): string {
  return sql.exec<{ epoch: string }>("SELECT epoch FROM sync_meta WHERE id = 1").one().epoch;
}

function maxSeq(sql: SqlDb): number {
  return sql.exec<{ s: number | null }>("SELECT max(seq) s FROM sync_log").one().s ?? 0;
}

export function currentCursor(sql: SqlDb): string {
  return `${readEpoch(sql)}.${maxSeq(sql)}`;
}

// Parses "<epoch>.<seq>"; "", "0" and undefined mean a full sync.
export function parseCursor(raw: string | null | undefined): { epoch: string; seq: number } | null | "bad" {
  if (raw == null || raw === "" || raw === "0") return null;
  const m = /^([0-9a-f]{1,32})\.(\d{1,15})$/.exec(raw);
  return m ? { epoch: m[1], seq: Number(m[2]) } : "bad";
}

const iso = (ms: number | null): string | null => (ms == null ? null : new Date(ms).toISOString());

// Due and start are dates, stored either at UTC midnight (Graph write-through)
// or at local midnight (the To Do app). Both lie within 12 hours of UTC
// midnight on the intended date (src/core/util/dates.ts), so rounding to the
// nearest UTC midnight recovers the date without knowing the zone.
export function bareDate(ms: number | null): string | null {
  if (ms == null) return null;
  return new Date(Math.round(ms / 86_400_000) * 86_400_000).toISOString().slice(0, 10);
}

function parseJson<T>(s: string | null, fallback: T): T {
  if (s == null) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

type Row = Record<string, SqlValue>;

// Every sid of `kind` for the given Graph IDs, in one query.
function sidsFor(sql: SqlDb, kind: string, graphIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < graphIds.length; i += 200) {
    const chunk = graphIds.slice(i, i + 200);
    const rows = sql
      .exec<{ graph_id: string; sid: string }>(
        `SELECT graph_id, sid FROM entity_map WHERE kind = ? AND graph_id IN (${chunk.map(() => "?").join(",")})`,
        kind,
        ...chunk,
      )
      .toArray();
    for (const r of rows) out.set(r.graph_id, r.sid);
  }
  return out;
}

function inPlaceholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(",");
}

// Builds FeedTask payloads for a set of task Graph IDs (a page's worth), with
// their steps, links and attachments, every reference translated to a sid.
// Tasks whose row is gone are absent from the result.
export function buildTasks(sql: SqlDb, taskIds: string[]): Map<string, { data: FeedTask; field_clock: Record<string, number> }> {
  const out = new Map<string, { data: FeedTask; field_clock: Record<string, number> }>();
  if (taskIds.length === 0) return out;
  const tasks: Row[] = [];
  const steps: Row[] = [];
  const links: Row[] = [];
  const atts: Row[] = [];
  for (let i = 0; i < taskIds.length; i += 200) {
    const chunk = taskIds.slice(i, i + 200);
    const ph = inPlaceholders(chunk.length);
    tasks.push(...sql.exec(`SELECT * FROM tasks WHERE task_id IN (${ph})`, ...chunk).toArray());
    steps.push(...sql.exec(`SELECT * FROM checklist_items WHERE task_id IN (${ph}) ORDER BY created_at, item_id`, ...chunk).toArray());
    links.push(...sql.exec(`SELECT * FROM linked_resources WHERE task_id IN (${ph}) ORDER BY link_id`, ...chunk).toArray());
    atts.push(...sql.exec(`SELECT * FROM attachments WHERE task_id IN (${ph}) ORDER BY attachment_id`, ...chunk).toArray());
  }
  const listSids = sidsFor(sql, "list", [...new Set(tasks.map((t) => t.list_id as string))]);
  const taskSids = sidsFor(sql, "task", taskIds);
  const stepSids = sidsFor(sql, "step", steps.map((s) => s.item_id as string));
  const linkSids = sidsFor(sql, "link", links.map((l) => l.link_id as string));
  const attSids = sidsFor(sql, "attachment", atts.map((a) => a.attachment_id as string));

  const group = <T>(rows: Row[], map: (r: Row) => T | null) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const v = map(r);
      if (v == null) continue;
      const k = r.task_id as string;
      (m.get(k) ?? m.set(k, []).get(k)!).push(v);
    }
    return m;
  };
  // A child with no sid yet can't be named by the client; it is skipped and
  // arrives once minted (the mint trigger runs on insert, so this is a guard).
  const stepsBy = group<FeedStep>(steps, (s) => {
    const id = stepSids.get(s.item_id as string);
    return id
      ? {
          id,
          title: (s.display_name as string | null) ?? null,
          checked: s.is_checked === 1,
          checked_at: iso(s.checked_at as number | null),
          created_at: iso(s.created_at as number | null),
          order: (s.order_datetime as string | null) ?? null,
        }
      : null;
  });
  const linksBy = group<FeedLink>(links, (l) => {
    const id = linkSids.get(l.link_id as string);
    return id
      ? {
          id,
          url: (l.web_url as string | null) ?? null,
          title: (l.display_name as string | null) ?? null,
          app: (l.application_name as string | null) ?? null,
          external_id: (l.external_id as string | null) ?? null,
        }
      : null;
  });
  const attsBy = group<FeedAttachment>(atts, (a) => {
    const id = attSids.get(a.attachment_id as string);
    return id
      ? {
          id,
          name: (a.name as string | null) ?? null,
          size: (a.size as number | null) ?? null,
          content_type: (a.content_type as string | null) ?? null,
        }
      : null;
  });

  const clocks = new Map<string, Record<string, number>>();
  const sids = [...taskSids.values()];
  for (let i = 0; i < sids.length; i += 200) {
    const chunk = sids.slice(i, i + 200);
    const rows = sql
      .exec<{ sid: string; field: string; at_ms: number }>(
        `SELECT sid, field, at_ms FROM field_clock WHERE kind = 'task' AND sid IN (${inPlaceholders(chunk.length)})`,
        ...chunk,
      )
      .toArray();
    for (const r of rows) (clocks.get(r.sid) ?? clocks.set(r.sid, {}).get(r.sid)!)[r.field] = r.at_ms;
  }

  for (const t of tasks) {
    const id = t.task_id as string;
    const sid = taskSids.get(id);
    const content = t.body_content as string | null;
    out.set(id, {
      data: {
        list_id: listSids.get(t.list_id as string) ?? null,
        title: t.title as string,
        status: t.status as string,
        body: content == null || content === "" ? null : { type: ((t.body_type as string | null) ?? "text").toLowerCase(), content },
        importance: (t.importance as string | null) ?? null,
        categories: parseJson<string[]>(t.categories_json as string | null, []),
        due: bareDate(t.due_at as number | null),
        start: bareDate(t.start_at as number | null),
        reminder: { on: t.is_reminder_on === 1, at: iso(t.reminder_at as number | null) },
        completed_at: iso(t.completed_at as number | null),
        recurrence: parseJson<unknown>(t.recurrence_json as string | null, null),
        created_at: iso(t.created_at as number | null),
        modified_at: iso(t.modified_at as number | null),
        order: (t.order_datetime as string | null) ?? null,
        my_day: {
          committed_day: (t.committed_day as string | null) ?? null,
          committed_order: (t.committed_order as string | null) ?? null,
          postponed_day: (t.postponed_day as string | null) ?? null,
        },
        subresources_complete: t.checklist_synced_at != null,
        steps: stepsBy.get(id) ?? [],
        links: linksBy.get(id) ?? [],
        attachments: attsBy.get(id) ?? [],
      },
      field_clock: (sid && clocks.get(sid)) || {},
    });
  }
  return out;
}

function buildLists(sql: SqlDb, listIds: string[]): Map<string, FeedList> {
  const out = new Map<string, FeedList>();
  for (let i = 0; i < listIds.length; i += 200) {
    const chunk = listIds.slice(i, i + 200);
    const rows = sql.exec(`SELECT * FROM lists WHERE list_id IN (${inPlaceholders(chunk.length)})`, ...chunk).toArray();
    for (const l of rows) {
      out.set(l.list_id as string, {
        name: (l.display_name as string | null) ?? null,
        wellknown: (l.wellknown as string | null) ?? null,
        is_owner: l.is_owner == null ? null : l.is_owner === 1,
        is_shared: l.is_shared == null ? null : l.is_shared === 1,
        group_id: null,
        sort_key: null,
      });
    }
  }
  return out;
}

// Tasks still waiting for the sub-resource scan. Flagged email is never
// scanned (sync-policy), so it isn't counted as outstanding.
export function backfillRemaining(sql: SqlDb): number {
  return sql
    .exec<{ n: number }>(
      `SELECT count(*) n FROM tasks t JOIN lists l ON l.list_id = t.list_id
       WHERE t.checklist_synced_at IS NULL AND (l.wellknown IS NULL OR l.wellknown <> 'flaggedEmails')`,
    )
    .one().n;
}

export function changesSince(
  sql: SqlDb,
  opts: { cursor?: string | null; limit?: number; scope?: string; now?: number },
): FeedResult {
  const scope = (opts.scope ?? "all") as FeedScope;
  if (scope !== "all" && scope !== "active") return { ok: false, error: "bad_scope" };
  const parsed = parseCursor(opts.cursor);
  if (parsed === "bad") return { ok: false, error: "bad_cursor" };
  const epoch = readEpoch(sql);
  const top = maxSeq(sql);
  let from = 0;
  if (parsed) {
    // Another epoch, or a position the log never reached (the database was
    // restored to an earlier point): the client starts over.
    if (parsed.epoch !== epoch || parsed.seq > top) return { ok: false, error: "cursor_reset" };
    // Retention (section 3.4) isn't built: nothing is pruned, so no cursor is
    // too old yet. When it is, a cursor below min_cursor returns cursor_expired.
    from = parsed.seq;
  }
  const full = parsed === null;
  const limit = Math.max(1, Math.min(MAX_PAGE_LIMIT, Math.floor(opts.limit ?? DEFAULT_PAGE_LIMIT)));
  const cutoff = (opts.now ?? Date.now()) - ACTIVE_COMPLETED_WINDOW_MS;

  // Scope is filtered in SQL so a page isn't spent on rows the device won't
  // keep. A deletion record always passes: the client deletes the entity if it
  // has it. The first page of a full sync skips deletion records, since the
  // client has nothing; later pages carry a cursor and may include some, which
  // the client ignores (deleting what it doesn't have is a no-op).
  const where: string[] = ["l.seq > ?"];
  const params: SqlValue[] = [from];
  if (full) where.push("l.deleted = 0");
  if (scope === "active") {
    where.push(
      "(l.kind <> 'task' OR l.deleted = 1 OR t.task_id IS NULL OR t.status <> 'completed' OR t.completed_at IS NULL OR t.completed_at >= ?)",
    );
    params.push(cutoff);
  }
  const rows = sql
    .exec<{ seq: number; kind: string; sid: string; deleted: number; graph_id: string | null }>(
      `SELECT l.seq, l.kind, l.sid, l.deleted, m.graph_id
         FROM sync_log l
         LEFT JOIN entity_map m ON m.kind = l.kind AND m.sid = l.sid
         LEFT JOIN tasks t ON l.kind = 'task' AND t.task_id = m.graph_id
        WHERE ${where.join(" AND ")}
        ORDER BY l.seq
        LIMIT ?`,
      ...params,
      limit + 1,
    )
    .toArray();

  const more = rows.length > limit;
  const pageRows = more ? rows.slice(0, limit) : rows;
  const taskData = buildTasks(
    sql,
    pageRows.filter((r) => r.kind === "task" && r.deleted === 0 && r.graph_id).map((r) => r.graph_id!),
  );
  const listData = buildLists(
    sql,
    pageRows.filter((r) => r.kind === "list" && r.deleted === 0 && r.graph_id).map((r) => r.graph_id!),
  );

  const changes: FeedChange[] = [];
  let bytes = 0;
  let lastSeq = from;
  let cut = false;
  for (const r of pageRows) {
    let c: FeedChange | null = null;
    const kind = r.kind as "task" | "list";
    if (r.deleted === 0 && kind === "task" && r.graph_id && taskData.has(r.graph_id)) {
      const t = taskData.get(r.graph_id)!;
      c = { kind, id: r.sid, seq: r.seq, deleted: false, data: t.data, field_clock: t.field_clock };
    } else if (r.deleted === 0 && kind === "list" && r.graph_id && listData.has(r.graph_id)) {
      c = { kind, id: r.sid, seq: r.seq, deleted: false, data: listData.get(r.graph_id)! };
    } else if (!full) {
      // Logged as live but the row is gone (or the log says deleted): tell the
      // client to drop it. A later insert logs it again as live.
      c = { kind, id: r.sid, seq: r.seq, deleted: true };
    }
    if (c) {
      const size = JSON.stringify(c).length;
      if (changes.length > 0 && bytes + size > PAGE_BYTE_BUDGET) {
        cut = true;
        break;
      }
      bytes += size;
      changes.push(c);
    }
    lastSeq = r.seq;
  }
  const hasMore = more || cut;
  // Caught up: the cursor moves to the top of the log, past any rows the scope
  // filtered out after the last one sent (section 18.6).
  const cursorSeq = hasMore ? lastSeq : Math.max(lastSeq, top);
  return {
    ok: true,
    page: {
      cursor: `${epoch}.${cursorSeq}`,
      has_more: hasMore,
      changes,
      backfill: { remaining: backfillRemaining(sql) },
    },
  };
}

// One task by sid, for GET /api/v1/tasks/{sid}: a search hit or a link to a
// task outside the device's scope.
export function taskBySid(sql: SqlDb, sid: string): { id: string; data: FeedTask; field_clock: Record<string, number> } | null {
  const m = sql
    .exec<{ graph_id: string | null }>("SELECT graph_id FROM entity_map WHERE kind = 'task' AND sid = ?", sid)
    .toArray()[0];
  if (!m?.graph_id) return null;
  const t = buildTasks(sql, [m.graph_id]).get(m.graph_id);
  return t ? { id: sid, ...t } : null;
}

// Graph task IDs → sids, for serving search results by sid.
export function taskSids(sql: SqlDb, taskIds: string[]): Record<string, string> {
  return Object.fromEntries(sidsFor(sql, "task", taskIds));
}
