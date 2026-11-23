# Client sync API — design

Status: **approved 2026-11-23.** Building in the order of section 12; each build step is its own PR.

This server becomes the back end for a native macOS and iOS app that keeps a local
SQLite copy of every list and task and syncs with the server. The design has five
parts:

- **Pull**: `GET /api/v1/sync/changes?cursor=…` returns every entity that changed
  since the cursor, deletions included.
- **Push**: `POST /api/v1/sync/mutations` takes a batch of edits. Each edit has an ID
  the app generates, so a retry is safe.
- **Notify**: each open app holds a WebSocket to the `TodoIndex` Durable Object. On
  any change to the mirror the server sends `{"type":"changed","cursor":"…"}`, and the
  app pulls.
- **Change log**: a new migration adds one compacted change log. SQLite triggers write
  to it, so every writer is covered: Graph delta, webhooks, MCP tools, and the app.
- **Stable IDs**: the app never sees a Graph ID. Each entity has a server-side UUID
  that survives cross-list moves (Graph changes the task ID on a move) and becomes
  the primary key once Graph is turned off.

During the transition the server writes every app edit through to Graph, exactly as
the MCP tools do, so Microsoft To Do and the new app work side by side. After
Microsoft's shutdown a single setting switches the server to being the source of
truth. This document designs both modes and scopes the build to write-through only.

## Contents

1. [What the mirror holds today, and what the app needs](#1-what-the-mirror-holds-today-and-what-the-app-needs)
2. [Stable IDs](#2-stable-ids)
3. [Change log, cursor, and deletion records](#3-change-log-cursor-and-deletion-records)
4. [Pulling changes](#4-pulling-changes)
5. [Sending edits](#5-sending-edits)
6. [Conflicts: newest edit per field wins](#6-conflicts-newest-edit-per-field-wins)
7. [Push over WebSocket](#7-push-over-websocket)
8. [Auth for apps](#8-auth-for-apps)
9. [Shared routing with the n8n HTTP API (ROADMAP §1)](#9-shared-routing-with-the-n8n-http-api-roadmap-1)
10. [After Graph: the gap list](#10-after-graph-the-gap-list)
11. [What stays unchanged](#11-what-stays-unchanged)
12. [Build order](#12-build-order)
13. [Decisions from review](#13-decisions-from-review)
14. [Multiple accounts](#14-multiple-accounts)
15. [Sign-in providers beyond Microsoft](#15-sign-in-providers-beyond-microsoft)
16. [Running without Cloudflare](#16-running-without-cloudflare)
17. [Sharing with other users](#17-sharing-with-other-users)

---

## 1. What the mirror holds today, and what the app needs

The `TodoIndex` mirror was built to answer MCP queries, not to be a full replica. These
gaps have to close before an app can be built on it. Each fix is in the build order
(section 12).

| Data | Mirror today | App needs | Fix |
|---|---|---|---|
| Task body | `body_plain` only: HTML stripped (`taskToRow` → `stripHtml`) | The body as stored, with its content type | Add `body_content` and `body_type` to `TASK_COLUMNS`. Delta already carries `body`. |
| Checklist items (steps) | Cache behind `ENABLE_CHECKLIST_CACHE` (default off; on in this deployment). **Open tasks only**, by design. Order not stored. | Every task's steps, including completed tasks, with order | Extend the scan to completed tasks and archive lists, and store `order_datetime` per step (section 1.1). |
| Linked resources | Not stored | Stored | New `linked_resources` table, filled by the same per-task scan. |
| Attachments | `has_attachments` flag only | Metadata (name, size, type) per attachment. Bytes are fetched on demand. | New `attachments` table, filled by the same scan when `has_attachments = 1`. |
| My Day fields | Filled by a budgeted Substrate scan plus a targeted refresh on each webhook | Same | No change. |
| Skipped lists (`no_sync` in `config:lists`, plus the built-in `flaggedEmails`) | Not mirrored at all | Kept, but shown only in an archive area of the app | New `archive` sync policy (section 1.2). |
| List groups, sidebar order | Not stored; Graph doesn't expose them | Stored | Section 10.4. |

### 1.1 One per-task sub-resource scan

Graph `$delta` carries no expansions, so steps, linked resources and attachments are
never free: each task costs at least one extra GET. Today's checklist scan
(`#runChecklistScanBatch`) already has the right shape: a `checklist_synced_at` marker,
nulled whenever the task rides delta, drained by a budgeted scan on calm cycles.

The proposal generalizes that scan instead of adding two more:

- Rename the marker's meaning to "sub-resources synced at". Keep the column name.
- One `GET …/tasks/{id}?$expand=checklistItems,linkedResources` per task fills both
  tables. When `has_attachments = 1`, add one `GET …/tasks/{id}/attachments`. (Graph
  silently ignores `$expand=attachments`; see CLAUDE.md.)
- Step order needs one Substrate `listSubtasks` call per task. Do it only for tasks
  whose Graph checklist is non-empty. Order is null until a step is first dragged, so
  most of these calls return nulls; that is accepted for the app, because showing
  steps in the wrong order is visible.
- Scope: every task in a mirrored list, open or completed, archive lists included.
  Open tasks drain first, newest change first; completed tasks follow. This reverses
  the checklist cache's current rule that completed tasks are deliberately excluded
  (CLAUDE.md). That rule fit a cache for follow-up queries; it doesn't fit a store
  that becomes the only copy once Graph is gone, so the old steps, links and
  attachment details are filled in now, while Graph can still supply them.
- **Gating.** The scan runs when the sync API is enabled, whatever
  `ENABLE_CHECKLIST_CACHE` says: an app can't work with steps missing. Fetching steps,
  links and attachments uses Graph alone. Only step **order** needs Substrate (the
  Exchange Online scope behind `ENABLE_MY_DAY`); a deployment without it syncs steps
  in creation order with `order: null`, the same fallback `list_checklist_items` uses
  today.

**First-sync cost.** Using the numbers in the decisions note (512 open, about 1,971
completed as of 2026-10), the backfill is roughly 2,500 task GETs plus the steps and
attachments calls. At today's default of 8 tasks per cycle that takes days. The
build adds a one-time backfill mode that raises the per-cycle budget until the
`NULL` set is empty, then drops back. The server reports backfill progress in
`/sync/changes` (`backfill: {remaining}`) so the app can show it.

The MCP tools keep working the whole time; they read the same tables.

### 1.2 Archive lists

Lists that aren't mirrored today are mostly ones no longer in active use. Their tasks
must not be lost, and they should be cleaned up over time from the app, but they
shouldn't sit in the main sidebar.

A third value joins the per-list sync policy in `config:lists`: `archive`, alongside
the default (mirrored) and `no_sync`.

- **Mirrored like any other list,** on a slower cadence: archive lists sync after
  every active list in each cycle, and get no Graph subscription (no webhook), so they
  add no latency to active lists and spend none of the tenant's subscription budget.
- **Flagged in the feed:** the list entity carries `"archived": true`. The app shows
  archive lists in a separate, collapsed area and leaves their tasks out of My Day
  suggestions and smart lists.
- **Unchanged for the MCP tools:** cross-list queries (`query_tasks`,
  `get_pending_across_lists`, `search_tasks`) skip archive lists unless a call names
  one explicitly. That keeps MCP results the same as today, when these lists aren't in
  the mirror at all.
- **Moving a list to `archive`** is a config edit (`set_list_config`); moving the
  existing `no_sync` lists over is a one-time edit after the migration ships.
  `flaggedEmails` becomes `archive` by default, since its tasks come from flagged mail
  that should stay findable.

---

## 2. Stable IDs

**Problem.** A Graph task ID encodes its folder. A move between lists — whether from
`move_task` (Substrate re-parent) or from Microsoft To Do itself — produces a **new
ID** for the same task (`substrate-client.ts` `reparentTask`, and the `move_task` tool
returns `previous_task_id`). If the app keyed on Graph IDs, every move would look like
a delete plus a create: open detail views close, and queued edits fail.

**Proposal.** Every list, task, step, linked resource and attachment gets a stable ID
(`sid`), a UUID. The app only ever sees `sid`s. A new `entity_map` table maps each
`sid` to the current Graph ID:

```sql
CREATE TABLE entity_map (
  kind       TEXT NOT NULL,      -- 'list' | 'task' | 'step' | 'link' | 'attachment'
  sid        TEXT NOT NULL,      -- UUID; client-generated for app creates, server-generated otherwise
  graph_id   TEXT,               -- NULL while a create is pending, and always NULL in local mode
  created_ms INTEGER NOT NULL,
  PRIMARY KEY (kind, sid)
);
CREATE UNIQUE INDEX entity_map_graph ON entity_map(kind, graph_id) WHERE graph_id IS NOT NULL;
```

- **App creates.** The app generates the `sid` (UUIDv7) when it creates the entity,
  offline or not. The server stores that `sid`. **The app never has to remap an
  ID** — when the Graph write succeeds the server fills in `graph_id`. This answers
  "how does an offline-created task get matched to its Graph ID": the app doesn't
  need to know the Graph ID exists.
- **Everything else** (Graph delta, webhooks, MCP tools) gets a server-minted `sid`
  the first time its Graph ID is seen.
- **Moves through this server** (`move_task`, an app move) re-point the map row from
  the old Graph ID to the new one *before* the mirror rows are re-keyed, so the `sid`
  carries on.
- **Moves made in Microsoft To Do** arrive as a delta "removed" in one list and a new
  task in another, possibly in different sync cycles, in either order. The server
  matches the pair on Graph `createdDateTime` plus title within one sync window and
  keeps the old `sid`. A brief removal followed by the same `sid` reappearing is legal
  in the change feed (section 4.3), so a match that lands a cycle late is still
  correct.
- **To verify in the first build PR:** whether a re-parented task keeps its
  `createdDateTime` (the match key), and whether Graph's `Prefer: IdType="ImmutableId"`
  header applies to `todoTask`. Microsoft documents immutable IDs for Outlook
  messages, events and contacts; I haven't found it documented for To Do tasks. If it
  works, Microsoft To Do moves keep their ID and the matcher becomes unnecessary — but
  switching ID type changes every ID the MCP tools have ever returned, so it would be a
  separate decision.

The MCP tools keep using Graph IDs. They call `IndexCore` methods that take Graph IDs,
and the map is maintained underneath them (section 3.2).

---

## 3. Change log, cursor, and deletion records

### 3.1 Schema: migration v4

`modified_at` from Graph isn't a usable cursor. Substrate fields (My Day, order) change
without it, MCP write-throughs land before delta does, and the server's own clock is
the only one that orders changes from every source. The proposal is a compacted change
log with a server-assigned, strictly increasing sequence number:

```sql
-- One row per entity, ever. A change deletes the entity's row and inserts it again,
-- so the row moves to a new, higher seq. AUTOINCREMENT guarantees seq is never reused,
-- even after the highest row is deleted.
CREATE TABLE sync_log (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  kind    TEXT NOT NULL,
  sid     TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,   -- 1 = deletion record ("tombstone")
  list_sid TEXT,                         -- the list it belongs to; for sharing (section 17.3)
  at_ms   INTEGER NOT NULL,
  UNIQUE (kind, sid)
);
-- Plus: entity_map (section 2), field_clock (section 6), applied_mutations (section 5),
-- linked_resources, attachments, and the new task/step columns from section 1.
```

Why one compacted log rather than a `seq` column on each table plus a separate
tombstone table:

- **Pagination is safe without snapshots.** An entity that changes while a client is
  paging moves to a higher `seq`, so the client sees it later in the same walk. It can
  be seen twice; it can't be missed.
- **Deletion records are the same row**, with `deleted = 1`. Retention is one
  `DELETE … WHERE deleted = 1 AND at_ms < ?`.
- **No change to `TASK_COLUMNS` or the delta UPSERT** for the bookkeeping. The entity
  tables stay as they are, apart from the new data columns in section 1.

The cursor sent to clients is `"<epoch>.<seq>"`. `epoch` is a random ID stored in DO
storage and replaced only when every client must start over: an identity reset
(`resetIdentity`), or a restore of the database. A client whose cursor carries a
different epoch gets `410 cursor_reset` and does a full sync.

### 3.2 Triggers write the log, so every writer is covered

The change log is written by SQLite triggers on `tasks`, `lists`, `checklist_items`,
`linked_resources` and `attachments` — not by each code path. That covers the delta
apply, webhook refreshes, the My Day and checklist scans, every MCP write-through,
`resync`, and any writer added later. For `tasks`:

```sql
-- Mint a sid for a Graph ID seen for the first time (delta, MCP tools).
CREATE TRIGGER tasks_map_ai AFTER INSERT ON tasks BEGIN
  INSERT OR IGNORE INTO entity_map (kind, sid, graph_id, created_ms)
    VALUES ('task', <uuid expression>, new.task_id, <now>);
END;
CREATE TRIGGER tasks_log_ai AFTER INSERT ON tasks BEGIN
  INSERT OR REPLACE INTO sync_log (kind, sid, deleted, at_ms)
    SELECT 'task', sid, 0, <now> FROM entity_map WHERE kind = 'task' AND graph_id = new.task_id;
END;
-- Fires only when a synced column actually changed, so a delta re-apply of an
-- identical task, or a checklist_synced_at marker write, logs nothing.
CREATE TRIGGER tasks_log_au AFTER UPDATE ON tasks
  WHEN old.title IS NOT new.title OR old.status IS NOT new.status OR … BEGIN
  INSERT OR REPLACE INTO sync_log … ;
END;
CREATE TRIGGER tasks_log_ad AFTER DELETE ON tasks BEGIN
  INSERT OR REPLACE INTO sync_log (kind, sid, deleted, at_ms)
    SELECT 'task', sid, 1, <now> FROM entity_map WHERE kind = 'task' AND graph_id = old.task_id;
END;
```

The `WHEN` clause is generated from the column list in code, so it can't drift from
`TASK_COLUMNS`. `INSERT OR REPLACE` deletes the old log row and inserts a new one,
which is what moves the entity to a fresh `seq`.

Two things to confirm in the first build PR, against both hosts' SQLite:

- `AUTOINCREMENT` (which needs the `sqlite_sequence` table) is allowed in Durable
  Object SQLite. `PRAGMA user_version` isn't (see `migrations.ts`), so I'm not
  assuming. The fallback is a one-row counter table, read and bumped by the triggers.
- A UUID expression inside a trigger. SQLite has no UUID function;
  `lower(hex(randomblob(16)))` gives 128 random bits, which is enough for a `sid`. The
  server can format it as a UUID when serving it.

### 3.3 `resync` and the 410 re-baseline stop deleting first

Today `resync()` and the delta-token-expired path (`#purgeResource`) delete a list's
rows, then rebuild them over several sync cycles. With a change feed, that would send
thousands of deletion records and then thousands of re-creations, and the app would
show tasks vanishing for minutes.

The proposal changes both to **mark and sweep**: record a baseline generation, upsert
everything the new baseline returns (unchanged rows log nothing, thanks to the `WHEN`
guard), and when the baseline reaches its `deltaLink`, delete only the rows the
baseline didn't touch. The MCP-visible behavior improves too: no window where a
resynced list looks empty. The `entity_map` rows survive a delete, so a task that
reappears in the baseline keeps its `sid`.

`resetIdentity` still wipes everything. It also replaces the epoch, so clients start
over cleanly.

### 3.4 Retention

Deletion records older than 90 days are pruned on calm cycles. The server keeps the
highest pruned `seq` as `min_cursor`. A client presenting a cursor below it gets
`410 cursor_expired` and does a full sync. With one row per entity, the log's size is
bounded by the number of entities that have ever existed — a few thousand rows here.

### 3.5 Sources that don't come from the mirror

The roster of skipped lists and per-list config (`config:lists` in KV) don't live in
SQLite. If the app needs list aliases or the sync policy, they get a `config` entity
in the log, written by the config loader when a blob is saved. Not needed for the
first version.

---

## 4. Pulling changes

### 4.1 Request

```
GET /api/v1/sync/changes?cursor=<epoch>.<seq>&limit=500&scope=active
Authorization: Bearer <access token>
```

- `scope` selects how much history this device keeps (section 4.5).
- No `cursor` (or `cursor=0`) means a full sync. Deletion records are skipped, because
  the client has nothing to delete.
- `limit` caps entities per page (default 500, max 1000). The server also stops a page
  at about 1 MB of JSON, because task bodies vary in size.

### 4.2 Response

```json
{
  "cursor": "k3v9.18452",
  "has_more": true,
  "changes": [
    { "kind": "list", "id": "0190…", "seq": 18001, "deleted": false,
      "data": { "name": "🧾INVOICING", "wellknown": null, "group_id": null, "sort_key": null } },
    { "kind": "task", "id": "0190…", "seq": 18002, "deleted": false,
      "data": {
        "list_id": "0190…", "title": "…", "status": "notStarted",
        "body": { "type": "text", "content": "…" },
        "importance": "normal", "categories": ["…"],
        "due": "2026-11-24", "start": null,
        "reminder": { "on": true, "at": "2026-11-24T14:00:00Z" },
        "completed_at": null, "recurrence": { "…": "Graph patternedRecurrence, as stored" },
        "created_at": "2026-11-20T15:04:05Z", "modified_at": "2026-11-23T21:00:00Z",
        "order": "2026-11-23T21:00:00.000Z",
        "my_day": { "committed_day": "2026-11-23", "committed_order": "…", "postponed_day": null },
        "subresources_complete": true
      },
      "field_clock": { "title": 1795470000000, "status": 1795470100000 } },
    { "kind": "step", "id": "0190…", "seq": 18003, "deleted": false,
      "data": { "task_id": "0190…", "title": "…", "checked": false, "checked_at": null,
                "created_at": "…", "order": null } },
    { "kind": "link", "id": "0190…", "seq": 18004, "deleted": false,
      "data": { "task_id": "0190…", "url": "https://…", "title": "…", "app": "…" } },
    { "kind": "attachment", "id": "0190…", "seq": 18005, "deleted": false,
      "data": { "task_id": "0190…", "name": "invoice.pdf", "size": 48213,
                "content_type": "application/pdf" } },
    { "kind": "task", "id": "0190…", "seq": 18006, "deleted": true }
  ],
  "backfill": { "remaining": 0 }
}
```

Rules:

- `cursor` is the position to send next time. When `has_more` is `false` the client is
  caught up as of that cursor.
- `data` is the entity's **current** state at read time, not the state at `seq`. The
  client replaces its row.
- Every reference to another entity (`list_id`, `task_id`) is a `sid`.
- Due and start dates go out as bare dates in the owner's `TIMEZONE`, which is how To
  Do treats them. Instants (reminders, completion, created, modified) go out as UTC
  ISO 8601.
- `subresources_complete: false` means the per-task scan (section 1.1) hasn't reached
  this task yet. The app shows what it has and gets the rest in a later pull.
- Attachment bytes aren't in the feed. The app fetches them with
  `GET /api/v1/attachments/{sid}`, which streams through the server the same way
  `/download` does today (section 10.2).

### 4.3 Client rules

- Apply each page in one local transaction, and save the cursor in that same
  transaction.
- Don't assume a parent arrives before its children. A task can appear in an earlier
  page than its list, because the list changed later. Local foreign keys must be
  deferred or absent until `has_more` is `false`.
- A deletion record followed later by the same `id` without `deleted` is an undelete.
  This happens when a Microsoft To Do move is matched a cycle late (section 2).
- On `410 cursor_reset` or `410 cursor_expired`, start a full sync. Keep local
  unsent edits and send them after the full sync.

### 4.4 Cost of a full sync

About 2,500 tasks, a few thousand steps, and the lists fit in roughly 10 to 15 pages.
Each page is one indexed range scan on `sync_log` plus primary-key lookups. On
Cloudflare it's one Durable Object RPC per page.

### 4.5 Per-device scope

Completed tasks grow without limit, and task bodies sometimes hold semi-confidential
details, so each device chooses how much it keeps. The choice is an app preference,
sent as `scope` on every pull:

| `scope` | Tasks sent | Default on |
|---|---|---|
| `active` | Open tasks, plus tasks completed in the last 30 days | iPhone |
| `all` | Every task | Mac |

Archive lists (section 1.2) follow the same rule: under `active` only their open
tasks arrive. Steps, links and attachment metadata follow their task.

How the filter stays correct:

- The server leaves out of-scope tasks when serving a page. The change log itself is
  shared by every device; there is no per-device state on the server.
- A task that changes is sent with its current state. A task completed 40 days ago
  and reopened today arrives as an open task, because reopening wrote a new `seq`.
- A task that leaves scope only by aging past 30 days produces no change. The app
  prunes those itself, using the same rule, after each pull.
- Changing a device's scope means a full sync.

What an `active` device can still reach without holding everything:

- `GET /api/v1/tasks/{sid}` returns one task with its steps, links and attachment
  metadata, for a search hit or a link to an old task.
- `GET /api/v1/search?q=…` runs the server's existing FTS search over every task. The
  app uses it when a local search finds nothing, or offers it as "search all history".

**Attachment bytes** are downloaded ahead of time only for open tasks, on every
device. Other attachments download when opened. This is app behavior; the server
serves the bytes either way.

**At rest on the device**, the local database must use iOS Data Protection class
`complete` (unreadable while the phone is locked), and signing out deletes it. On the
Mac it relies on FileVault. These are app requirements, listed here because they're
the other half of the scope decision.

---

## 5. Sending edits

### 5.1 Request

```
POST /api/v1/sync/mutations
Authorization: Bearer <access token>
Content-Type: application/json

{
  "client_id": "mac-01J…",
  "mutations": [
    { "id": "m-0190…", "at": "2026-11-23T21:04:05.123Z",
      "op": "task.create", "sid": "0190…",
      "fields": { "list_id": "0190…", "title": "Call Acme", "due": "2026-11-24" } },
    { "id": "m-0190…", "at": "2026-11-23T21:04:09.001Z",
      "op": "task.update", "sid": "0190…",
      "fields": { "title": "Call Acme re: renewal", "importance": "high" } },
    { "id": "m-0190…", "at": "2026-11-23T21:04:12.500Z",
      "op": "myday.add", "sid": "0190…", "position": { "after": "0190…" } }
  ]
}
```

- `id`: a UUID the app generates once per edit and keeps across retries.
- `at`: when the edit was made on the device. Used for conflicts (section 6).
- `client_id`: a per-install ID. Used in logs and, later, for APNs device routing.
- At most 100 mutations per request. A mutation can take two or three Graph or
  Substrate calls, and the Worker is on the paid plan, so the subrequest limit isn't
  the constraint; the cap keeps one request's run time short.

### 5.2 Operations

| `op` | Fields | Write-through (today's code path) |
|---|---|---|
| `list.create` | `name` | Graph `POST /lists` |
| `list.update` | `name` | Graph `PATCH` |
| `list.delete` | — | Graph `DELETE` |
| `task.create` | `list_id`, any task field | Graph `POST`, then any Substrate fields |
| `task.update` | any subset of: `title`, `body`, `status`, `completed_at`, `importance`, `due`, `start`, `reminder`, `categories`, `recurrence` | Graph `PATCH` with only those fields |
| `task.delete` | — | Graph `DELETE` |
| `task.move` | `list_id`, optional `position` | Substrate re-parent, with `move_task`'s fallback |
| `task.reorder` | `position` | Substrate `OrderDateTime`, via `reorder.ts` |
| `myday.add` / `myday.remove` | optional `position` | Substrate `CommittedDay` / `CommittedOrder` |
| `myday.reorder` | `position` | Substrate `CommittedOrder`, via `my-day-order.ts` |
| `step.create` / `step.update` / `step.delete` | `task_id`, `title`, `checked` | Graph `checklistItems` |
| `step.reorder` | `position` | Substrate `patchSubtask` |
| `link.create` / `link.update` / `link.delete` | `task_id`, `url`, `title` | Graph `linkedResources` |

`position` is `{ "before": sid }`, `{ "after": sid }`, `{ "top": true }` or
`{ "bottom": true }`. The server converts it to an order value with the existing
reorder math, using its own view of the neighbors. Sending neighbors rather than raw
order values keeps To Do's descending-`OrderDateTime` encoding out of the app, so the
encoding can change after Graph without an app update.

Attachments are uploaded through a separate endpoint (`POST /api/v1/attachments`,
multipart), not this batch, because the body is binary and can be up to 25 MiB. The
existing upload code (`src/core/upload/`) does the Graph side.

### 5.3 Response

The status is `200` whenever the batch was parsed, even if every mutation failed. The
per-mutation results are what the app acts on.

```json
{
  "cursor": "k3v9.18460",
  "results": [
    { "id": "m-…", "status": "applied", "sid": "0190…" },
    { "id": "m-…", "status": "applied", "sid": "0190…",
      "superseded_fields": ["importance"] },
    { "id": "m-…", "status": "failed", "error": "graph_unavailable", "retry": true }
  ]
}
```

| `status` | Meaning | App action |
|---|---|---|
| `applied` | Written to Graph and the mirror. `superseded_fields` lists fields skipped because a newer edit already set them (section 6). | Drop from the queue. |
| `duplicate` | This `id` was already applied. The stored result is returned. | Drop from the queue. |
| `rejected` | Will never succeed: validation error, unknown `sid`, entity deleted. `error` names the reason. | Drop, and revert the local change by pulling. |
| `failed` | Not applied. `retry: true` for throttling or Graph outages; `false` otherwise. | Retry later if `retry`, else treat as rejected. |
| `skipped` | An earlier mutation in this batch for the same entity failed, so this one wasn't tried. | Retry with the batch. |

Mutations run **in order**, one at a time. Substrate rejects parallel calls on one
mailbox anyway, and order matters for a create followed by edits. After the batch, the
response carries the new cursor. The app still pulls to get the authoritative state;
the WebSocket also announces the change to every other device.

### 5.4 Idempotency

```sql
CREATE TABLE applied_mutations (
  mutation_id TEXT PRIMARY KEY,
  state       TEXT NOT NULL,      -- 'pending' | 'done'
  result_json TEXT,
  principal   TEXT NOT NULL,      -- who sent it (section 15.2); "edited by" for sharing
  at_ms       INTEGER NOT NULL
);
```

1. Before any Graph call, the server inserts the mutation as `pending`. If the row is
   already `done`, it returns the stored result as `duplicate`.
2. After the Graph call and the mirror write, it stores the result and marks the row
   `done`, in the same SQLite transaction as the mirror write.
3. Rows are kept for 30 days, longer than the app keeps an unsent edit.

The hard case is a crash or timeout **after** Graph accepted a create and **before**
step 2. A plain retry would create a second task. For a `pending` create, the server
first looks for the task it may already have made: tasks in the target list created
after the `pending` row's timestamp with the same title. If exactly one matches, it
adopts that Graph ID. An update or delete is safe to repeat as-is. A stronger match is
to write the `sid` into a Graph open extension on create; whether To Do tasks accept an
`extensions` array in the create body is a thing to test before relying on it.

### 5.5 Where the code lives

The MCP tool handlers in `register-tools.ts` (about 4,800 lines) are closures bound to
`McpServer`. Neither this API nor ROADMAP §1 can reuse them as they stand. The first
build step extracts the write logic into `src/core/ops/` — plain functions taking a
`GraphClient`, an optional `SubstrateClient`, and the index — and makes the MCP tools
call them. Existing MCP tests guard the refactor. The sync mutation handler and the
§1 routes then call the same functions, so the three surfaces can't drift.

---

## 6. Conflicts: newest edit per field wins

"Newest" needs a definition. There are three writers: this app on several devices,
Microsoft To Do, and MCP tools.

- **App edits** carry `at`, the device time of the edit. The server clamps it to
  `min(at, server receive time)`, so a device whose clock runs fast can't win forever.
- **Server-side edits** (MCP tools, Graph delta) use the server's clock. For a delta
  change the server uses Graph's `lastModifiedDateTime`, applied to each column that
  differs from the stored row.
- A `field_clock(kind, sid, field, at_ms)` table stores the time of the edit that set
  each field's current value.

When a `task.update` arrives, each field whose stored clock is newer than the
mutation's `at` is dropped and reported in `superseded_fields`. The other fields go to
Graph. This only matters when an edit sat in a queue — the app was offline, or the
request was retried. Online, edits arrive in order and nothing is superseded. The
decisions note says the app is almost always online, so I expect this path to run
rarely; the logs will show how rarely.

What this doesn't do:

- **No merge inside a field.** A body edited on two devices keeps the newer whole body.
- **Delete wins over edit.** An edit to a deleted entity is `rejected` with
  `error: "deleted"`. An app that wants to keep the edit re-creates the task.
- **Microsoft To Do still has the last word on its own writes.** If a To Do edit
  reaches Graph after an app edit, the To Do edit wins, whatever its device time.
  Graph is the source of truth until the switch.

Invariants stay on the server, applied together: completing a task sets `status` and
`completed_at` in one write, and in Graph mode Microsoft creates the next instance of a
repeating task (section 10.1).

---

## 7. Push over WebSocket

### 7.1 Protocol

```
GET /api/v1/sync/socket        (WebSocket upgrade)
Authorization: Bearer <access token>
```

`URLSessionWebSocketTask` can set this header, so the token stays out of the URL and
out of logs.

Server → client messages:

- On connect: `{"type":"hello","cursor":"k3v9.18460"}`. The app pulls if its cursor is
  older.
- After any change: `{"type":"changed","cursor":"k3v9.18461"}`.
- Before closing for token expiry or revocation: `{"type":"reauth"}`.

The app sends nothing except WebSocket pings. A `ping` text message gets `pong`
through the hibernation auto-response, so it never wakes the Durable Object.

### 7.2 Cloudflare host

1. The Worker authenticates the upgrade like any `/api/v1` request (section 8), then
   forwards it to the `TodoIndex` singleton's `fetch()`. `TodoIndex` has no `fetch()`
   today; the new one accepts only this upgrade.
2. `TodoIndex` calls `ctx.acceptWebSocket(server)` (the hibernation API), and stores
   `{grant epoch, token expiry, client_id}` with `serializeAttachment`.
3. `IndexCore` gets a new port, `ChangeNotifier { announce(cursor): void }`, in
   `ports.ts`. The Cloudflare implementation sends to every socket from
   `ctx.getWebSockets()`, and closes any whose token has expired or whose epoch is
   stale, after sending `reauth`.
4. `revokeAllGrants` and `resetIdentity` close every socket.

**When the server announces.** After each committed write — not once per sync cycle.
`IndexCore` compares the log's highest `seq` with the last one announced, at the end
of each RPC that writes and after each resource in `runSyncCycle`. A burst of writes
inside one RPC sends one message.

**Webhook latency.** Today a webhook arms the alarm, and the next cycle walks the
roster delta and then every list in priority order (about 38 lists). The list that
changed may be near the end of that walk. The proposal makes `onChangeNotification`
mark the notified lists as hot, and `runSyncCycle` syncs hot lists first. With an
announcement after each resource, the path is: webhook → alarm → one list delta →
mirror write → `changed`. I expect that to be a second or two after the webhook; the
end-to-end test in the "done" criteria measures it.

The DO evicts from memory between events but the sockets stay open, so idle sockets
cost no duration charges.

### 7.3 Node host

- Add the `ws` package (no dependencies). Listen for `upgrade` on the server that
  `@hono/node-server`'s `serve()` returns, in `noServer` mode, for this one path.
- Authenticate the upgrade with the OAuth library's `getOAuthApi(options, env)
  .unwrapToken(token)` plus the same grant check (`grantRefusal`) the `/mcp` route
  uses. The upgrade never reaches the fetch-style handler.
- The `ChangeNotifier` implementation is an in-memory set of sockets. The Node host
  runs one process (`single-instance.ts` enforces it), so no cross-process fan-out is
  needed.
- The Node host's request rewrite to `SERVICE_BASE_URL` and the body caps don't apply
  to an upgrade. Cap incoming WebSocket messages at 1 KiB, since the protocol only
  carries pings.

### 7.4 Apple push notifications (later phase)

APNs plugs in at the same point. A second `ChangeNotifier` implementation sends a
background push to each registered device that has no open socket. Device tokens are
registered by a later `POST /api/v1/devices`, keyed by `client_id`. The server signs
APNs requests with an ES256 JWT from a `.p8` key held as a secret; WebCrypto does
ES256 on both hosts. Reminders are local notifications the app schedules from synced
data, so APNs is only for "wake up and pull", and iOS may throttle those.

---

## 8. Auth for apps

**Recommendation: the app is an OAuth client of the existing provider.** It gets the
same consent page, the same Microsoft sign-in, the same `OWNER_EMAIL` gate, and the
same grant epoch, so `revoke_all_connections` signs the app out like any MCP
connector.

The flow is authorization code with PKCE (S256) through `ASWebAuthenticationSession`,
with an **`https` callback on one fixed domain the app owns** — for example
`https://todo-app.<your domain>/oauth/callback` — that the app claims through an
Associated Domains entitlement. That domain serves
`/.well-known/apple-app-site-association`; a static page or a small Worker route is
enough. The callback is deliberately **not** on each server's host: Associated Domains
are fixed when the app is built, so a per-server callback would need an app update for
every new server. An OAuth redirect URI doesn't have to share the server's host, so
every server can send its code to the same domain (section 14).
`ASWebAuthenticationSession` supports `https` callbacks from iOS 17.4 and macOS 14.4;
the app targets the current iOS and macOS releases, so that's no constraint. The OAuth
library already accepts `https` redirect URIs, so no library option changes.

A custom URL scheme is not used. Any app on the device can register the same scheme
and receive the code; PKCE stops it redeeming the code, but the `https` callback stops
it receiving the code at all. `allowPrivateUseRedirectUris` stays off.

**Client registration.** The app registers itself as a public client (no secret)
through dynamic client registration (`/register`) the first time it signs in to a
server, and stores the returned `client_id` with that account. Each server is its own
OAuth issuer, so a `client_id` built into the app would only work on one server
(section 14). The registration sends a fixed client name, so the consent page and the
grant list show the app the same way on every server.

**Token lifetimes.** Access tokens last one hour, and refresh tokens slide to 14 days
from last use (`src/hosts/shared/oauth.ts`). An iPhone app left unused for two weeks
has to sign in again. That's the existing connector policy; changing it for the app
alone is possible later through the `tokenExchangeCallback`.

**Keeping an app token out of MCP, and an MCP token out of the sync API.** The library
binds every token to one canonical resource (`<origin>/mcp`) and accepts it on every
`apiRoute`. So without a scope check, a Claude connector's token could call
`/api/v1/sync/mutations`, and the app's token could call `/mcp`. Both belong to the
owner, but neither needs the other's access. The proposal: the app requests scope
`sync`; the `/api/v1/sync/*` handler requires it; `/mcp` refuses a token whose only
scope is `sync`. Because `/mcp` refuses only `sync`-only tokens, existing connector
grants keep working whatever scopes they were issued with.

### 8.1 Cloudflare Access in front of the app

On deployments that use it (section 16), Access stays a second, independent gate: a request must pass Access at the edge and
then present a valid OAuth token with scope `sync`. Neither layer trusts the other.

**Which paths Access covers.** One Access application on this hostname, scoped to
`/api/v1/sync/*`, `/api/v1/tasks/*`, `/api/v1/search`, `/api/v1/attachments/*`, and
the app's sign-in path (below). These paths stay **outside** Access, because their
callers can't complete an Access login: `/mcp` and the OAuth endpoints Claude's
connectors use, `/webhook` (Microsoft Graph), and the single-use-link `/upload` and
`/download`.

**How a native app passes Access.** Access accepts its session token in a
`cf-access-token` request header, which is how non-browser clients call
Access-protected APIs. The app gets that token during sign-in:

1. The app opens `https://<host>/app/signin` in `ASWebAuthenticationSession`. That path
   is behind Access, so the session shows the Access login first.
2. After Access lets the request through, the Worker reads the validated
   `Cf-Access-Jwt-Assertion` header, checks its signature and audience against the
   team's Access keys, and starts the OAuth authorization (consent page, Microsoft
   sign-in, `OWNER_EMAIL` gate).
3. The final redirect to the `https` app callback carries the OAuth code and the Access
   token. The callback is a universal link handled inside the session, so neither
   value crosses the network again.
4. The app sends `cf-access-token` and `Authorization: Bearer` on every request,
   including the WebSocket upgrade. When Access answers with its login redirect
   instead of the API response, the session has expired and the app repeats sign-in.
   If the identity provider's session is still valid, that completes without a prompt.

Step 3 is this server's own addition to the redirect, not something Access documents
for native apps. **To verify in the build:** that Access accepts the assertion JWT from
step 2 in the `cf-access-token` header (the documented flows use the `CF_Authorization`
token, and the two may differ), and how long the Access session lasts for this
application.

**Passkeys instead of emailed codes.** Access's one-time PIN is the emailed code.
Replacing it is an Access configuration change, not server code: add Microsoft Entra
ID as the Access identity provider and remove one-time PIN from this application. Entra
supports passkeys as a sign-in method, so a passkey stored in 1Password signs in to both
Access and the OAuth flow's Microsoft step, which is the same account the `OWNER_EMAIL`
gate already checks. Confirmed 2026-11-23: Microsoft sign-in with a passkey stored in
1Password works on this tenant.

The bearer-token idea in ROADMAP §1 (`HTTP_API_TOKEN`) is for n8n. It isn't the app's
auth: a static secret can't be revoked per device and doesn't go through Microsoft
sign-in. Section 9 covers it.

---

## 9. Shared routing with the n8n HTTP API (ROADMAP §1)

Both surfaces live under `/api/v1`, behind one router and one auth layer:

```
src/core/api/
  router.ts     # /api/v1/* path → handler; both hosts mount it
  auth.ts       # resolves a request to { principal, scopes } or a 401/403
  sync/         # changes, mutations, socket, attachments
  routes/       # the ROADMAP §1 per-tool routes (built later)
src/core/ops/   # write logic shared by MCP tools, the sync API and §1 routes (section 5.5)
```

- The OAuth provider moves from `apiRoute: "/mcp"` to `apiHandlers`, with `/mcp` and
  `/api/v1` as separate entries. The grant check runs in both.
- A static `HTTP_API_TOKEN` for n8n enters through the provider's
  `resolveExternalToken` hook, compared in constant time, and maps to scope `api`. It
  never carries `sync`. Cloudflare Access service tokens, the other §1 option, are
  checked at the edge before the Worker runs and need no code here.
- `router.ts` is in `src/core`, so both hosts get it. On Node it is mounted in
  `createHandler`, behind the existing body caps.

Building the §1 routes isn't part of this work. Only the shared router, auth layer and
`ops/` extraction are, and they make §1 a matter of adding route files.

---

## 10. After Graph: the gap list

This section is design only. Nothing here is built until the switch is near.

**Precondition for the switch:** the sub-resource backfill (section 1.1) reports
`remaining: 0` and every attachment's bytes are in the blob store (section 10.2).
Anything not captured before Graph is turned off is lost, so the switch refuses to run
until both hold.

One setting selects the mode: `SYNC_SOURCE=graph` (the default and the only built
mode) or `local`. In `local` mode the mutation handler writes the mirror directly;
delta sync, webhooks, subscriptions and the Substrate scan are off; `graph_id` stays
null; and the `sid` is the only ID. The MCP tools switch from Graph calls to the same
`ops/` functions in their local form, which is why section 5.5 extracts them now.

### 10.1 Repeating tasks

In Graph mode, completing a repeating task makes Microsoft create the next instance
(a new task with a new ID). The mirror picks it up through delta. In local mode the
server does it inside the completing mutation's transaction: it marks the instance
complete, computes the next due date from the stored `recurrence` (Graph's
`patternedRecurrence` shape, kept as is), and inserts the next instance with a new
`sid`. That's also where the decisions note's "real completion date and history for
recurring tasks" gets built, since each completed instance stays a row.

### 10.2 Attachment storage

A new `BlobStore` port in `ports.ts`: R2 on Cloudflare, a directory on Node. In Graph
mode it is unused; `GET /api/v1/attachments/{sid}` streams bytes from Graph the way
`/download` does. Migration before the switch copies every attachment's bytes into the
store. The volume is unknown — a `SUM(size)` over the new `attachments` table will
give it once the backfill runs.

### 10.3 IDs for new items

Already solved by section 2: the `sid` is the primary key in both modes.

### 10.4 List groups and sidebar order

Graph exposes neither. **I couldn't check Substrate from this session**: the server's
Substrate token never leaves the server, and the To Do web app's network traffic needs
a signed-in browser. The check belongs in the first build PR, as a temporary
owner-only probe that logs the response shapes of:

- `GET {substrate}/todob2/api/v1/taskfolders?$select=*` — look for a group or parent
  field and an order field on each folder;
- `GET {substrate}/todob2/api/v1/taskgroups` — the old Outlook REST tasks API had a
  task-groups collection, and the To Do back end may still serve it.

Whatever the answer, the schema gets `list_groups(sid, name, sort_key, collapsed)` and
`lists.group_sid` and `lists.sort_key`. If Substrate exposes them, they're mirrored
read-only in Graph mode. If not, they're app-owned from the start: the app's edits to
groups and sidebar order apply to the mirror only, with no write-through, and
Microsoft To Do keeps its own separate grouping until the switch.

---

## 11. What stays unchanged

- **MCP tools.** Same names, inputs, outputs and Graph IDs. The `ops/` extraction
  changes where the code lives, not what it does; the existing tests in `test/` and
  `test-node/` run unchanged before and after.
- **Node/Docker host.** Gets the same features through ports. New dependency: `ws`.
- **Webhooks and delta sync.** Same triggers and budgets. Changes: hot lists sync
  first (section 7.2), and `resync`/410 use mark and sweep (section 3.3).
- **Single owner.** Every new route goes through the existing grant check.
  Sharing with other users is designed in section 17; the parts that must exist
  from the start are built with the change log.

---

## 12. Build order

Each step is one PR with tests on both hosts (`test/` for the Workers pool, `test-node/`
for Node). Nothing ships until this document is approved.

1. **Spike, behind no flag:** check `AUTOINCREMENT` and trigger-based UUIDs in Durable
   Object SQLite; whether a re-parented task keeps `createdDateTime`; whether
   `Prefer: IdType="ImmutableId"` works on `todoTask`; the Substrate list-group probe.
   Results go in the decisions note and adjust sections 2, 3 and 10.4.
2. **Migration v4:** `entity_map`, `sync_log` (with `list_sid`), triggers,
   `field_clock`, mark-and-sweep for `resync`/410, and `Props.principal` on new grants
   (section 15.2). No API yet; tests assert log rows for every writer.
3. **Mirror completeness:** body columns, `linked_resources`, `attachments`, step
   order, the generalized sub-resource scan with backfill mode, the `archive` list
   policy.
4. **`ops/` extraction** from `register-tools.ts`. MCP behavior unchanged.
5. **Router and auth:** `/api/v1` mount on both hosts, `sync` scope, the Access
   sign-in path, `GET /sync/info`, `GET /sync/changes` with `scope`, `GET /tasks/{sid}`, `GET /search`.
6. **`POST /sync/mutations`** with idempotency and field clocks.
7. **WebSocket push** on both hosts, plus hot-list-first sync.
8. **End-to-end check:** a script holds a WebSocket to the deployed Worker, I edit a
   task in Microsoft To Do, and the script reports the time from the webhook log line to
   the `changed` message, then confirms `/sync/changes` returns the edit.

---

## 13. Decisions from review

Answered 2026-11-23:

1. **Unmirrored lists** are kept, shown only in an archive area of the app (section 1.2).
2. **History on devices** is a per-device preference: the Mac keeps everything by
   default, the iPhone keeps open and recently completed tasks (section 4.5). The server
   still backfills every task's steps, links and attachment metadata, open tasks first,
   so the Mac's full copy and on-demand fetches work. Attachment bytes download ahead
   of time only for open tasks.
3. **Workers plan** is paid: mutation batches go up to 100.
4. **Sign-in** uses the `https` callback; the app targets current OS releases.
   Cloudflare Access stays in front of the app's paths, and passkey sign-in through
   Entra replaces Access's emailed codes (section 8.1).

Nothing is open. The items marked **To verify** above are checks for the build, not
decisions.

---

## 14. Multiple accounts

The app will hold more than one account at once — for example a work and a personal
To Do — each backed by its **own deployment of this server** on its own Cloudflare
account. It shows them together, the way Outlook's unified inbox does, while keeping
each account's data separate. Microsoft To Do on iOS could switch between two
accounts, but only one at a time, and each switch meant a slow full re-sync; macOS
couldn't do it at all. Here every account stays synced all the time, so there is
nothing to switch.

### 14.1 The server stays single-owner

Nothing in sections 1 to 13 changes. Each deployment serves one owner, and the app
talks to several deployments. The server needs only two additions, both small enough
to build now:

- **`GET /api/v1/sync/info`** returns what the app needs to set up and label an
  account:

  ```json
  {
    "server_id": "c1b0…",
    "account": { "name": "David (work)", "email_hint": "d…@…" },
    "version": "0.18.0",
    "capabilities": { "my_day": true, "step_order": true, "push": "websocket",
                      "source": "graph" }
  }
  ```

  `server_id` is a random ID created once and stored in DO storage. It never changes,
  unlike the cursor epoch, which changes on an identity reset. The app keys the
  account's local data by it, so re-adding the same server is recognized.
  `capabilities` tells the app what this server supports: a deployment without the
  Exchange Online scope has no My Day and no step order, and a deployment whose
  Microsoft account can't receive Graph change notifications has slower push. The
  app hides or degrades features per account instead of assuming every server is the
  same.
- **Sign-in that works for any server:** dynamic client registration and one shared
  callback domain (section 8). With a built-in `client_id` and per-server callbacks,
  adding a second server would need an app release.

**Personal Microsoft accounts** (outlook.com) are not expected to work as a back end
today: the owner gate and tenant handling were written for a work tenant, and Graph
doesn't send To Do change notifications for personal accounts. Section 15 separates
who may sign in from where the data comes from, which is the change that would make
such a deployment possible later.

### 14.2 What the app must get right from the start

These are cheap on day one and expensive to retrofit, so the first app version builds
them even with one account:

- **One local database file per account**, named by `server_id`. Removing an account
  deletes its file; nothing is left behind in a shared table. Unified views query
  across files with SQLite `ATTACH`, which allows up to 10 attached databases by
  default.
- **Every local key includes the account.** `sid`s are random UUIDs and won't collide
  across servers, but view state, selection, queued edits and notifications are keyed
  by `(server_id, sid)`, so nothing in the app assumes one server.
- **One sync engine per account:** its own cursor, mutation queue, WebSocket, OAuth
  tokens and Access token in the Keychain. A slow or signed-out account never blocks
  another.
- **The account is a field of every entity in the view model,** even when only one
  account exists, so a row can show an account color or badge later without a model
  change.

### 14.3 What can wait

- **Unified views** — My Day, Important, Planned and search across accounts. Built on
  the `ATTACH` queries above, with each row marked by account color. Within a unified
  My Day, manual order stays per account: each server owns its own order, so the
  unified view groups by account instead of interleaving. A cross-account manual order
  would need storage that belongs to no server; the doc records it as possible later,
  not designed here.
- **Moving a task between accounts.** No server can do this atomically, because the
  two accounts don't share a back end. The app would create the task in the
  destination, confirm it, then delete it from the source, and tell the user that the
  task's history doesn't move with it.
- **Account management UI** — add, rename, color, reorder and remove accounts.

With 14.1 and 14.2 in place, adding these later is UI work only.

---

## 15. Sign-in providers beyond Microsoft

Today one Microsoft sign-in does two jobs at once:

- **Identity:** it decides who the owner is (`isOwner()` against `OWNER_EMAIL` and
  `OWNER_OBJECT_ID`).
- **Data access:** the same authorization returns the Graph and Substrate tokens the
  server uses to read and write To Do.

After Graph is gone the second job disappears, and the server still needs the first.
So the design separates them:

- **An identity provider** answers "who is signing in". It is the upstream of this
  server's OAuth flow (`beginUpstream` / `finishUpstream` in
  `src/hosts/shared/auth-handler.ts`, which today always goes to Microsoft).
- **A data source** answers "where do tasks come from". Graph is the only one built
  (`SYNC_SOURCE=graph`); `local` comes later (section 10). Connecting Graph remains a
  Microsoft authorization, but it becomes a connection the owner makes, not the
  sign-in itself.

### 15.1 One mechanism: OpenID Connect

Every identity provider worth supporting speaks OpenID Connect, so the server
implements one generic OIDC upstream (authorization code with PKCE, ID token
validated against the provider's published keys) instead of one integration per
vendor:

| Provider | How it fits |
|---|---|
| Microsoft Entra ID | Today's provider, expressed as OIDC. Passkeys from 1Password already work. |
| Cloudflare Access, as an OIDC provider ("Access for SaaS") | Access issues the ID token, and behind it any login method Access offers: Entra, Google, GitHub, one-time PIN. One Access configuration can then gate the API (section 8.1) and supply identity. |
| A self-hosted provider (Pocket ID, Authentik, Keycloak) | For deployments without Cloudflare or Microsoft (section 16). Pocket ID is built around passkeys. |
| Google, Apple | Possible through the same OIDC code; no need identified. |

Microsoft keeps one extra step in Graph mode: after OIDC sign-in, the server also
needs delegated Graph and Exchange tokens. When the identity provider *is* Entra, one
authorization yields both, as it does today. When it isn't, the owner connects
Microsoft separately once, from a settings page.

### 15.2 The owner is an issuer and subject, not an email

`Props.user` in each grant holds an email today, and `isOwner()` already had to learn
that an email alone can't be trusted (`/me.mail` is admin-settable; the UPN check plus
`OWNER_OBJECT_ID` closed that). With several providers, the rule becomes general:

- A principal is the pair **(issuer, subject)** from the validated ID token. The
  subject is the provider's stable, non-reassignable user ID.
- The owner is configured as one such pair (or bootstrapped from an email on first
  sign-in, then pinned to the pair, the way `OWNER_OBJECT_ID` pins the Microsoft
  account today).
- Email is display data only. It never decides access.
- Grants carry the principal pair from the start (`Props.principal`), so adding a
  second provider later doesn't invalidate existing grants or the MCP connectors.

**Built now:** `Props.principal` alongside `Props.user`, set from the Microsoft sign-in
(issuer `https://login.microsoftonline.com/<tenant>/v2.0`, subject = the object ID).
**Built later:** the generic OIDC upstream and the provider setting.

---

## 16. Running without Cloudflare

The Node host (`src/hosts/node`, `docs/NODE-HOSTING.md`) already runs the MCP server
with no Cloudflare services. Everything in this document is designed to work there
too:

| Piece | Cloudflare host | Node host |
|---|---|---|
| Change log, cursor, sync endpoints | Durable Object SQLite | The same code over the SQLite file |
| Push | Hibernating WebSockets in `TodoIndex` | `ws` on the HTTP server (section 7.3) |
| Attachment storage after Graph | R2 | A directory (`BlobStore` port, section 10.2) |
| Edge gate | Cloudflare Access (section 8.1) | Optional: Cloudflare Tunnel plus Access in front of the Node host, a VPN such as Tailscale, or none |
| Identity | Microsoft, or Access as OIDC | Microsoft, or any OIDC provider (section 15) |
| Background push to phones (later) | APNs from the Worker | APNs from Node; the same ES256 signing |

Three consequences for the design:

- **The edge gate is per account, and the app detects it.** The app requests
  `GET /api/v1/sync/info` before signing in. If the answer is a redirect to a
  `cloudflareaccess.com` login, Access is in front and the app runs the Access step of
  section 8.1; if it's the JSON response, there's no edge gate. Nothing about Access is
  hard-coded into the app's notion of an account.
- **Reverse proxies must pass WebSocket upgrades.** A Node deployment behind nginx,
  Caddy or Traefik needs the upgrade headers forwarded for `/api/v1/sync/socket`.
  `NODE-HOSTING.md` gets the snippet when push ships.
- **Backups become the operator's job once the server is primary storage.** Durable
  Object SQLite has Cloudflare's point-in-time recovery. A Node deployment has
  whatever the operator sets up. Before `SYNC_SOURCE=local` is allowed on Node, the
  host gets a built-in periodic snapshot (`VACUUM INTO` a timestamped file, keeping the
  last N) and `NODE-HOSTING.md` documents copying it off the machine. In Graph mode
  this doesn't matter, since Microsoft holds the data.

---

## 17. Sharing with other users

Microsoft To Do lets the owner of a list share it with specific people, who can then
read and edit its tasks. This isn't built now, but the design must not rule it out.

### 17.1 Topology: several users on one deployment

Two models were considered:

- **Federation:** each person runs their own server, and servers exchange shared
  lists. Every server would need to trust other servers, resolve conflicts between
  two copies, and handle one side going away. Too much machinery for the need.
- **Several users on one deployment (recommended):** a deployment admits more than
  one principal (section 15.2). A shared list is stored once, in that deployment, and
  each member syncs it like their own lists. This is what To Do does inside
  Microsoft's service.

With the second model, "the server is single-owner" becomes "the server has one
administrator and an allowlist of principals". The `OWNER_EMAIL` gate becomes the
first entry on that allowlist. The singleton `TodoIndex` can hold several users' data
for the scale that matters here — a family or a small team. Splitting into one Durable
Object per user is possible later but isn't required by anything above.

To share across deployments — for example, the work server and someone else's — a
person is added to the deployment that owns the list, and their app adds it as an
extra account (section 14). No federation needed.

### 17.2 Data model

- **The unit of sharing is the list.** Tasks, steps, links and attachments belong to
  exactly one list and inherit its access.
- `list_members(list_sid, principal, role, added_ms)`, with roles `owner` and
  `editor`. Every list has exactly one owner.
- Each user's private data stays per user: My Day membership and order, and possibly
  list order in the sidebar. To Do shows a shared task in My Day for whoever added it,
  not for every member. So the My Day fields move from the task row to a per-principal
  table when sharing is built: `my_day(principal, task_sid, committed_day,
  committed_order, postponed_day)`.

### 17.3 What must exist from the start

These are cheap in migration v4 and expensive to retrofit, so they're built now:

- **Every `sync_log` row records its list.** A new `list_sid` column, filled by the
  triggers (a task's own list; a step's task's list). Serving a filtered feed — "only
  lists this principal can see" — is then an indexed condition, the same kind of
  filter as the per-device scope in section 4.5.
- **Every applied mutation records its principal.** `applied_mutations.principal`,
  from `Props.principal`. This is also the "edited by" data a shared list shows.
- **The feed already tolerates filtering.** Section 4.5 established that a filtered
  feed over the shared log stays correct as long as the client prunes what leaves its
  view. Losing access to a list is the one case the client can't detect on its own,
  so removing a member writes a deletion record for that list into the removed
  member's view, and the client deletes the list and everything in it.

### 17.4 What changes when sharing is built

- The grant check admits any allowlisted principal, not only the owner.
- `/sync/changes` filters by membership; the WebSocket announces a change only to
  sockets whose principal can see the list it touched, so one member can't watch
  another's private lists change.
- The MCP tools take the calling principal into account. Today every MCP call is the
  owner's.
- In Graph mode, sharing stays Microsoft's: lists shared through To Do already appear
  in the mirror with `is_shared` set. Lists other people share *with* the owner belong
  to those people's Microsoft accounts, so they disappear when Graph is turned off
  unless they are copied first. The switch to local mode lists them so the owner can
  decide.

---

## Revisions

- 2026-11-23: sections 15 to 17 added after review (sign-in providers, hosts other
  than Cloudflare, sharing). Items built now: `Props.principal`, `sync_log.list_sid`,
  `applied_mutations.principal`.

## Spike results (build step 1)

- 2026-11-23, both hosts' SQLite (`test/sync-spike-sqlite.test.ts`,
  `test-node/sync-spike-sqlite.test.ts`): `AUTOINCREMENT` works in Durable Object
  SQLite as run by the Workers test pool and in `node:sqlite`; a `seq` is not reused
  after the highest row is deleted; a trigger can mint a `sid` with
  `lower(hex(randomblob(16)))`; a `WHEN old.x IS NOT new.x` guard keeps marker-only
  updates out of the log. The production Durable Object hasn't run this yet; the
  migration PR's deploy is the first time it does.
- 2026-11-23, live: a task re-parented with `move_task` (Substrate) kept its
  `createdDateTime` exactly (`2026-11-23T23:28:02.101119Z` before and after) while its
  ID changed. The move matcher in section 2 can key on it. Moves made in the To Do app
  use the same Substrate re-parent (see `reparentTask`), so I expect the same result
  there; the end-to-end test in step 8 confirms it.
- 2026-11-23, live on the Servant Voice test worker (`mstodo-mcp-sv`), with a
  temporary token-gated probe from the unmerged `scratch/sync-probe` branch:
  - **Immutable IDs work for To Do tasks.** With `Prefer: IdType="ImmutableId"`,
    Graph returns task IDs in a different form (`AAkAL…`). A task created, re-parented
    through Substrate, and read back kept the same immutable ID, while its plain ID
    changed. The old immutable ID still resolved after the move.
  - `…/tasks/delta` honors the header (every row came back as an immutable ID). List
    IDs are unaffected by the header, and lists never change ID anyway.
  - Substrate accepts an immutable task ID (`GET …/taskfolders/{list}/tasks/{immutable}`
    returned 200), and `POST /me/translateExchangeIds` converts between the two forms.
  - **Sidebar order and list groups exist in Substrate.** Each folder in
    `GET …/taskfolders` carries `OrderDateTime` (sidebar position, null for the
    default list) and `ParentFolderGroupId`, plus `ThemeColor` and `ThemeBackground`.
    `GET …/foldergroups` exists and returns a delta link; the test account has no
    groups, so the group object's fields are still unseen. (`taskgroups` and
    `taskfoldergroups` return "Endpoint not supported".)
  - Graph's `/me/todo/lists` and `…/tasks` reject `$select` with `ParseUri` errors.
- 2026-11-23, after David created two list groups in the Servant Voice account and
  moved one list into one of them: a group record from `GET …/foldergroups` has exactly
  `Id`, `Name` and `OrderDateTime`. The grouped list's `ParentFolderGroupId` equals the
  group's `Id`, and moving the list into the group gave it a new `OrderDateTime`; its
  Graph list ID did not change. Groups and ungrouped lists both carry `OrderDateTime`,
  so I read the sidebar as one ordering across both (to confirm with a reorder test).
  No collapsed or expanded state is stored server-side; the app keeps that locally.
  Section 10.4 can therefore mirror groups read-only in Graph mode instead of making
  them app-owned.
- Not yet checked: re-parenting by immutable ID (the move test passed the plain ID).

