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
18. [Revisions from the Fable review](#18-revisions-from-the-fable-review-2026-11-23)

---

## 1. What the mirror holds today, and what the app needs

The `TodoIndex` mirror was built to answer MCP queries, not to be a full replica. These
gaps have to close before an app can be built on it. Each fix is in the build order
(section 12).

| Data | Mirror today | App needs | Fix |
|---|---|---|---|
| Task body | `body_plain` only: HTML stripped (`taskToRow` → `stripHtml`) | The body as stored, with its content type | Add `body_content` and `body_type` to `TASK_COLUMNS`. Delta already carries `body`. |
| Checklist items (steps) | Cache behind `ENABLE_CHECKLIST_CACHE` (default off; on in this deployment). **Open tasks only**, by design. Order not stored. | Every task's steps, including completed tasks, with order | Extend the scan to completed tasks and reference lists, and store `order_datetime` per step (section 1.1). |
| Linked resources | Not stored | Stored | New `linked_resources` table, filled by the same per-task scan. |
| Attachments | `has_attachments` flag only | Metadata (name, size, type) per attachment. Bytes are fetched on demand. | New `attachments` table, filled by the same scan when `has_attachments = 1`. |
| My Day fields | Filled by a budgeted Substrate scan plus a targeted refresh on each webhook | Same | No change. |
| Lists not in active use | Classified `reference` or `excluded` for the MCP tools; only `no_sync` and `flaggedEmails` changed sync | One per-list setting that the app shows and can change | The list's class is its sync setting (section 1.2). |
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
- Scope: every task in a mirrored list, open or completed, reference lists included.
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

### 1.2 One sync setting per list

Decided 2026-11-24 (David): the list classification the MCP tools already use is also
the list's sync setting. There is one setting per list, not a classification plus a
separate sync policy.

| Setting | Sync behaviour |
|---|---|
| `todo` (default) | Mirrored at full speed, with a Graph subscription, so edits arrive by webhook and reach the app by push. |
| `reference` | Mirrored after every `todo` list in each cycle, with no Graph subscription: changes arrive on the sync timer. The sub-resource scan (section 1.1) covers its open tasks only. For lookup and collection lists, not active to-dos. |
| `excluded` | Not mirrored and never in the feed. The list stays in `list_lists` and its tasks stay readable live from Graph. |

A list nothing classifies (`unclassified` in `list_lists`) syncs as `todo`. Nothing
depends on `reference` existing: if it is dropped later, the setting is `todo` or
`excluded`.

**Where the setting comes from**, first hit wins (`classifyList`, `src/core/config/classifier.ts`):

1. An ID pin in `config:lists.overrides`. `set_list_config` and the app's
   `list.update` both write here, so a pin is the normal way to set a list. A list
   made with `list.create` or `create_list` is pinned `todo`, so a name that matches
   an `excluded` pattern can't drop it from the mirror.
2. The legacy arrays, by Graph list ID or `wellknownListName`: `no_sync` means
   `excluded`, `archive` means `reference`. Setting a list through `list.update` drops
   its ID from both.
3. `flaggedEmails` with no pin: `excluded`, or `reference` when `sync_flagged_emails`
   is on.
4. Name patterns, in order. `list_lists` pins pattern matches by ID, so a rename
   doesn't change the setting; it doesn't pin a list that step 2 or 3 decides.

**In the feed**, each list carries `"sync": "todo" | "reference"` (section 4.2). The
server stores the setting on the list's row (migration v11), so a changed setting logs
the list again and every client gets the new value. An excluded list is never sent:

- On an incremental pull, a list that became `excluded` arrives as a deletion record,
  and so does each of its tasks, because the server drops them from the mirror. The
  app keeps nothing from an excluded list.
- When a list is switched back on, it arrives again under the same `id`, and its tasks
  return as the next sync cycles baseline the list, under their old `id`s.

**Changing it from the app**: `list.update` with `{"sync": "excluded"}` (or `todo`,
`reference`), alone or with `name` (section 5.2). The server applies it before the
mutation returns, so the response cursor already covers the deletion records. A
setting is not sent to Microsoft To Do. The `sync` field has a field clock like any
other (section 6), stamped whenever the setting changes, whether from the app,
`set_list_config` or an edit to `config:lists`. A queued `list.update` older than
that change comes back with `sync` in `superseded_fields`.

**Writing into an excluded list**: the sync API refuses `task.*`, `myday.*`,
`step.*` and `link.*` mutations that touch an excluded list (the task's list, or
`fields.list_id`) with `rejected` / `list_excluded`. List mutations on the excluded
list itself still run, so the app can rename it, delete it or switch it back on.
A `step.*` or `link.*` edit that names only the step or link, sent after the list
was excluded, comes back `rejected` / `deleted` instead: the server no longer knows
which task the step or link belonged to. Both errors mean the same to the app: drop
the edit and pull.
An MCP write tool can still create or move a task into an excluded list in Microsoft
To Do; the server keeps no copy of it.

**How a change is applied**: `config:lists` has one writer, the index
(`IndexCore.updateListsConfig`). It applies the change to the newest config it knows,
writes it to KV and applies it to the mirror at once. KV can serve the old value for
up to 60 s after a write, so for 90 s the sync cycle uses the config the index last
wrote instead of what it reads from KV. A list whose setting changes is synced first
in a cycle that starts at once, so a list switched back on is baselined without
waiting for the timer.

**Listing excluded lists**, since the feed doesn't carry them:

```
GET /api/v1/lists/excluded
→ { "lists": [ { "id": "0190…", "name": "GRAVEYARD", "wellknown": null } ] }
```

`id` is the list's sid, for `list.update`.

**MCP tools.** `list_lists` reports `type` on every list, and `set_list_config` writes
the same setting (`overrides`). `overrides` is merged key by key: the lists it names
get the new setting, `null` removes a pin, and pins it doesn't name stay as they are.
Cross-list queries (`query_tasks`, `get_pending_across_lists`, `search_tasks`) keep
today's behaviour: they cover every mirrored list, `reference` included, and
`exclude_types` filters by setting. An excluded list isn't mirrored, so the
cache-backed queries don't see it. When a read's list filter (`lists`, `types`,
`type` or `list`) names an excluded list, the result carries
`not_mirrored: [{ "list_id", "display_name" }]` and a one-line note, so an empty
result isn't mistaken for an empty list. `list_tasks` on an excluded list reads it
live from Graph (`source: "graph"`) and pages it through `next_cursor` as usual.
`list_my_day_tasks` names every excluded list the same way, since any of them can
hold My Day tasks it can't show. `list_lists` adds pins only for lists that have none,
so it never replaces a pin set since its own read of the config.

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
- **Moves made in Microsoft To Do** keep their ID, because the mirror switches to
  Graph **immutable** task IDs (decided 2026-11-23 after the spike and review; the
  migration is in section 18.2). The `createdDateTime`-plus-title matcher is dropped.
  `entity_map` stays: app creates, the copy-and-delete move fallback and local mode
  still need a server ID that isn't Graph's.

The MCP tools keep using Graph IDs, now in immutable form. A plain ID from an older
conversation is translated once at the tool boundary (section 18.2).

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
    { "kind": "list_group", "id": "0190…", "seq": 18000, "deleted": false,
      "data": { "name": "Clients", "sort_key": "2026-11-21T10:00:00.0000000Z" } },
    { "kind": "list", "id": "0190…", "seq": 18001, "deleted": false,
      "data": { "name": "🧾INVOICING", "sync": "todo", "wellknown": null, "is_owner": true,
                "is_shared": false, "group_id": "0190…",
                "sort_key": "2026-11-20T10:00:00.0000000Z",
                "theme": { "color": "…", "background": "…" }, "image_id": null,
                "image_style": null } },
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
        "subresources_complete": true,
        "steps": [ { "id": "0190…", "title": "…", "checked": false, "checked_at": null,
                     "created_at": "…", "order": null } ],
        "links": [ { "id": "0190…", "url": "https://…", "title": "…", "app": "…",
                     "external_id": null } ],
        "attachments": [ { "id": "0190…", "name": "invoice.pdf", "size": 48213,
                           "content_type": "application/pdf" } ]
      },
      "field_clock": { "title": 1795470000000, "status": 1795470100000 } },
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
- Due, start and completion dates go out as bare dates (`YYYY-MM-DD`) in the owner's
  `TIMEZONE`, which is how To Do treats them. `completed_at` is a date, not an instant:
  To Do shows only the day, and a value Graph stores as exact UTC midnight is read as
  that UTC date, anything else as the local date in `TIMEZONE`. The app sends
  `completed_at` back as a bare date too. Instants (reminders, created, modified) go
  out as UTC ISO 8601.
- `subresources_complete: false` means the server hasn't fetched this task's steps,
  links and attachments yet (the per-task scan, section 1.1). The app shows what it has
  and gets the rest in a later pull. Once fetched, it stays `true`: a later change to
  a step, link or attachment arrives as a new row for the task.
- A list's `group_id`, `sort_key` and `theme` describe the Microsoft To Do sidebar
  (section 10.4). They are `null` until the server first reads the sidebar, and always
  `null` on a server whose `capabilities.list_appearance` is `false`. `group_id` is
  the `id` of a `list_group` entity, or `null` for a list outside any group.
- A list's `image_id` is the app's background image for it, a `theme_image` entity's
  `id` or `null`, and `image_style` is how the app shows it (section 4.8). Both are
  kept by this server, not To Do.
- A `list_group` is a sidebar group: `{ name, sort_key }`. A deleted group arrives as
  a deletion record, and its lists arrive with `group_id: null`. The server logs a
  group before the lists a read moves into it, but a later rename moves the group
  after them, so the app must not depend on the order (section 4.3).
- A link's `external_id` is Graph's `externalId`: an ID its creator chose, or `null`.
  The server sets it to the link's `sid` on every link the app creates (section 5.4).
- Attachment bytes aren't in the feed. The app fetches them with
  `GET /api/v1/attachments/{sid}`, which streams them through the server from Graph
  (section 4.6).

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

Reference lists (section 1.2) follow the same rule: under `active` only their open
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

### 4.6 Downloading an attachment

```
GET /api/v1/attachments/{sid}
Authorization: Bearer <access token>
```

The server returns the attachment's bytes. `{sid}` is the `id` of an entry in a task's
`attachments` array in the feed. The token must be an `/api/v1` token; an `/mcp` token
gets `401`.

The server keeps a copy of each file attachment's bytes in R2 when the deployment has
a blob store (`capabilities.attachment_cache: true`). The first download fetches the
file from Graph (`/attachments/{id}/$value`), stores it under the attachment's `sid` and
returns it; later downloads come from R2 without a Graph call. A file uploaded through
this server (section 5.6) is stored at upload time. A To Do attachment can't be edited
in place, so a `sid` always names the same bytes. When an attachment leaves the mirror
(deleted in any app, or its list excluded), the daily sweep (section 4.9) removes its
copy. Without a blob store the server streams every download from Graph and stores
nothing. A To Do attachment is at most 25 MB.

A successful response carries these headers:

| Header | Value |
| --- | --- |
| `Content-Type` | The attachment's `content_type` from the mirror, or `application/octet-stream` when it has none or it isn't a valid media type. |
| `Content-Length` | Graph's length, when Graph sends one for an uncompressed body. Graph doesn't send one for `$value` today, so the app must not rely on it. |
| `Content-Disposition` | `attachment`, with an ASCII `filename` and the real name in `filename*=UTF-8''…`. Control characters are removed and the name is cut to 255 characters. |
| `Cache-Control` | `private, no-store` |
| `Content-Length` (from R2) | The stored size, on a download served from the blob store. |
| `X-Content-Type-Options` | `nosniff` |

Errors are JSON, like every other `/api/v1` error. `retry: true` means the same request
can succeed later.

| Status | Body | Meaning |
| --- | --- | --- |
| 404 | `{"error":"not_found"}` | The sid is unknown, the attachment was deleted, its list is excluded (section 1.2), or Graph no longer has it. The app drops it on its next pull. |
| 409 | `{"error":"not_a_file"}` | A reference attachment: a link, with no bytes to download. |
| 502 | `{"error":"graph_unavailable","retry":true}` | Graph answered 5xx, or the network failed. |
| 502 | `{"error":"graph_<status>","retry":false}` | Graph refused the request for another reason, such as `graph_403`. |
| 503 | `{"error":"graph_throttled","retry":true}` | Graph throttled the request (429) after the server's one retry. |
| 503 | `{"error":"reauth_required","retry":true}` | The owner must sign in to Microsoft again before the server can reach Graph. |

`GET /api/v1/sync/info` reports `capabilities.attachment_download: true` on servers
that have this route.

### 4.7 Link rules

```
GET /api/v1/link-rules
Authorization: Bearer <access token>
```

The owner's link rules turn text in a task into the task's link: a ticket number in a
title becomes a link to the ticket. The server applies them after every write that
changes a title or body through this server, from a sync mutation or an MCP tool, and
the resulting link reaches the app in the feed like any other. An edit made in
Microsoft To Do itself doesn't run them. This route lets the app also mark matches in
titles and notes as the person types, before that link exists.

```json
{
  "rev": "9f2c4e01a7b3d5e6",
  "rules": [
    {
      "id": "autotask-ticket",
      "pattern": "(T\\d{8}\\.\\d{4}(?:\\.\\d{3})?)",
      "flags": "",
      "fields": "both",
      "url_template": "https://example.autotask.net/…&TicketNumber=$1",
      "display_template": "Ticket $1",
      "application_name": "Autotask"
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `rev` | Changes whenever the returned rules change. `GET /api/v1/sync/info` carries the same value as `link_rules_rev`. |
| `pattern`, `flags` | A JavaScript regular expression, without delimiters. |
| `fields` | Where the rule looks: `title`, `body` (the task's note) or `both`. |
| `url_template`, `display_template` | `$1`, `$2`, … are replaced with the match's capture groups; a group that didn't take part becomes empty. A `display_template` of `null` means the matched text itself. |
| `application_name` | The name the link shows, as in "Open in Autotask". |

The route returns only rules that are enabled and whose `url_template` starts with
`http://` or `https://`. The server's dedupe template (`external_id_template`) isn't
sent; the app has no use for it.

**When to fetch.** Read `link_rules_rev` from `/sync/info` when the app starts and
after it reconnects, and fetch the rules when the value differs from the stored one.
`link_rules_rev` is `null` when the stored rules can't be read; the app keeps the copy
it has. A server without the field predates this route.

**How the server applies them, which the app must not contradict:**

- A task has at most one link while Microsoft To Do is the source. The server tries
  rules in array order, the title before the body for a `both` rule, and the first
  match becomes the link. Every other match only gets a highlight in the app.
- A task that already has a link, including the link Outlook adds to a flagged email,
  gets no new one.
- The server matches only the first 8,192 characters of a note.

**Running the patterns on Apple platforms.** `NSRegularExpression` (ICU) accepts the
syntax these rules use, including lookahead, lookbehind and named groups. Where it
differs:

- Flags: map `i` to `.caseInsensitive`, `m` to `.anchorsMatchLines` and `s` to
  `.dotMatchesLineSeparators`, and ignore `g`. Skip a rule whose flags include `u`, `y`,
  `d` or `v`.
- `\d` and `\w` match only ASCII in JavaScript but any Unicode digit or letter in ICU,
  so the app can mark a match the server won't link. The server's result is the one
  that counts.
- Skip a rule whose pattern fails to compile, rather than failing the whole set.

**What the app does with a match.** It builds the URL from `url_template` and opens it
only when the result is an `http` or `https` URL. A highlight looks different from the
task's real link and doesn't offer to edit or delete a link.

More than one link per task waits until the server is the source of record
(section 10); the feed's `links` array won't change shape.

### 4.8 Theme images and smart-list themes

Microsoft To Do can't store a custom background image, and it has no place for a
smart list's theme. The server keeps both for the app, so they sync between the app's
devices. They never reach To Do. These features need a blob store
(`capabilities.theme_images: true`).

**Theme images.** An image is uploaded once and can then be used by any number of
lists and smart lists.

```
POST /api/v1/theme-images?width=<px>&height=<px>[&brightness=<0..1>]
Authorization: Bearer <access token>
Content-Type: image/jpeg | image/png | image/heic
<the image bytes>
```

- The body is the image itself, at most 15 MiB. The server checks that the bytes are
  the type the `Content-Type` names and refuses anything else.
- The server doesn't decode the image. `width` and `height` (whole pixels, 1 to 20,000)
  and the optional `brightness` (0 for black to 1 for white, the app's measure) are
  stored as the app sends them and returned to every device.
- The `id` is derived from the bytes (the first 32 hex digits of their SHA-256), so it
  never changes and the same image uploaded twice gets the same `id`. Uploading again
  is safe: the second request returns the stored image.

| Status | Body |
| --- | --- |
| 201 | The new image: `{ "id", "content_type", "size", "width", "height", "brightness", "created_at" }` |
| 200 | Same body: these bytes were already stored. The stored `width`, `height` and `brightness` are kept. |
| 400 | `{"error":"bad_dimensions"}` or `{"error":"bad_brightness"}` |
| 413 | `{"error":"too_large"}` |
| 415 | `{"error":"unsupported_type"}`: not JPEG, PNG or HEIC, or the bytes don't match `Content-Type` |
| 501 | `{"error":"no_blob_store"}`: the deployment has no blob store |

Each image is a `theme_image` entity in the change feed, so a new image reaches the
app's other devices like any edit:

```json
{ "kind": "theme_image", "id": "3f9a…", "seq": 18100, "deleted": false,
  "data": { "content_type": "image/jpeg", "size": 2381120, "width": 3024,
            "height": 4032, "brightness": 0.42, "created_at": "2026-11-26T22:10:00Z" } }
```

The bytes come from:

```
GET /api/v1/theme-images/{id}
Authorization: Bearer <access token>
```

The response carries the image's `Content-Type`, `Content-Length`, `ETag: "<id>"` and
`Cache-Control: private, max-age=31536000, immutable`. An unknown or deleted `id` is a
404 with `{"error":"not_found"}`. The app caches images by `id` and never needs to
fetch one twice.

**A list's image.** Every list in the feed carries `image_id`: a theme image's `id`, or
`null`. The app sets it with `list.update { image_id }` (section 5.2). It is separate
from `theme`, which is To Do's own color and background and keeps round-tripping
unchanged. The app shows the list's To Do color behind the image, and alone when the
image can't be shown.

**Image style.** Each place an image is used has its own display settings, so one
image can be cropped differently on two lists. The image itself never changes. A list
carries them as `image_style`, set with `list.update { image_style }`, and a smart
list's theme carries them beside its `image_id`. `null` means the app's defaults.

| Key | Range | App default | Meaning |
| --- | --- | --- | --- |
| `focus_x`, `focus_y` | 0 to 1 | 0.5 | The point of the image kept in view when it is cropped to fill |
| `zoom` | 1 to 4 | 1 | Magnification |
| `shade` | -1 to 1 | 0 | A white wash when negative, a dark layer when positive |
| `blur` | 0 to 1 | 0 | Blur strength |
| `shade_dark` | -1 to 1, or `null` | `null` | The shade in dark mode; `null` means use `shade` |
| `card_opacity` | 0.2 to 1, or `null` | `null` | How opaque task cards are over the background in light mode; `null` means 1 (solid) |
| `card_opacity_dark` | 0.2 to 1, or `null` | `null` | The same in dark mode; `null` means use `card_opacity` |

An `image_style` has every key above, each a number in its range. The first five are
required. `shade_dark`, `card_opacity` and `card_opacity_dark` are optional: missing or
`null`, each is stored and sent as `null`. Anything else, a missing required key or an
extra key, is `rejected` with `invalid_field:image_style` (for a
smart list, `invalid_field:<key>`). A style can be set without an image, on a list
(`image_id: null`) or in a smart list's theme, so a color theme can carry card opacity
too.

**Smart-list themes.** One `app_settings` entity in the feed holds the theme of each
smart list. Its `id` is fixed for the server's lifetime, and it is always in a full
sync:

```json
{ "kind": "app_settings", "id": "a71c…", "seq": 18101, "deleted": false,
  "data": { "smart_lists": {
    "my_day":    { "color": "dark_blue", "image_id": "3f9a…",
                   "image_style": { "focus_x": 0.5, "focus_y": 0.3, "zoom": 1.2,
                                    "shade": 0.25, "blur": 0, "shade_dark": null,
                                    "card_opacity": 0.85, "card_opacity_dark": null } },
    "important": { "color": "dark_rose", "image_id": null, "image_style": null },
    "planned": null, "all": null, "completed": null } } }
```

Every key is present; `null` means the app's default. Tasks isn't here: it is the
default list (`wellknown: "defaultList"`), so its picture is that list's `image_id`. `color` is a name the app
chooses (lowercase letters, digits and `_`, up to 32 characters); the server stores
it without checking it against To Do's names. The app changes these with
`settings.update` (section 5.2).

**Deleting an image.** `theme_image.delete` removes an image nothing uses. One that a
list or smart list still uses is rejected with `theme_image_in_use`. The daily sweep
(section 4.9) also deletes an image nothing has used for 30 days.

### 4.9 Blob store and sweep

A deployment's blob store is one R2 bucket, bound as `BLOBS`. Attachment copies are
stored under `attachments/<sid>` and theme images under `theme-images/<id>`. Without
the binding, `capabilities.attachment_cache` and `capabilities.theme_images` are
`false`, downloads stream from Graph and the theme-image routes answer 501.

Once a day the server's cron sweeps the bucket. It deletes each attachment copy whose
attachment is no longer in the mirror, and each theme image that no list or smart list
has used for 30 days, counted from the first sweep that found it unused.

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
- At most 25 mutations per request, plus a per-request time budget: mutations left
  when the budget runs out come back `skipped`. A mutation takes two or three
  sequential Graph or Substrate calls, so 100 would outlast client timeouts and cause
  the very retries idempotency then has to absorb (section 18.4). The subrequest limit
  on the paid plan isn't the constraint.

### 5.2 Operations

| `op` | Fields | Write-through (today's code path) |
|---|---|---|
| `list.create` | `name` | Graph `POST /lists`, then the new list is pinned `todo` (section 1.2) |
| `list.update` | any subset of: `name`, `sync`, `theme`, `group_id`, `image_id`, `image_style` (at least one) | `name`: Graph `PATCH`. `sync`: `config:lists`, applied to the mirror at once (section 1.2); nothing goes to Graph. `theme`, `group_id`: Substrate `PATCH taskfolders/{id}` (section 10.4). `image_id`, `image_style`: server only (section 4.8). Allowed on an excluded list. |
| `list.delete` | — | Graph `DELETE` |
| `list.reorder` | `position` | Substrate `OrderDateTime` on the folder (section 10.4) |
| `list_group.create` | `name`, optional `position` | Substrate `POST foldergroups` (section 10.4); without a `position` the group goes to the top |
| `list_group.update` | `name` | Substrate `PATCH foldergroups/{id}` |
| `list_group.reorder` | `position` | Substrate `OrderDateTime` on the group |
| `list_group.delete` | — | Each list in the group is moved out (Substrate `PATCH taskfolders/{id}`), then Substrate `DELETE foldergroups/{id}`. The lists stay. |
| `task.create` | `list_id`, any task field | Graph `POST`, then any Substrate fields |
| `task.update` | any subset of: `title`, `body`, `status`, `completed_at`, `importance`, `due`, `start`, `reminder`, `categories`, `recurrence` | Graph `PATCH` with only those fields |
| `task.delete` | — | Graph `DELETE` |
| `task.move` | `list_id`, optional `position` | Substrate re-parent, with `move_task`'s fallback |
| `task.reorder` | `position` | Substrate `OrderDateTime`, via `reorder.ts` |
| `myday.add` | optional `position` | Substrate `CommittedDay`, then `CommittedOrder` when `position` isn't `top` |
| `myday.remove` | — | Substrate `CommittedDay` |
| `myday.reorder` | `position` | Substrate `CommittedOrder`, via `my-day-order.ts` |
| `step.create` | `task_id`, `title`, `checked` | Graph `POST checklistItems` |
| `step.update` | any subset of: `title`, `checked` | Graph `PATCH` with only those fields |
| `step.delete` | — | Graph `DELETE` |
| `step.reorder` | `position` | Substrate `patchSubtask` |
| `link.create` | `task_id`, `url`, `title` | Graph `POST linkedResources` |
| `link.update` | any subset of: `url`, `title` | Graph `PATCH` with only those fields |
| `link.delete` | — | Graph `DELETE` |
| `attachment.delete` | — | Graph `DELETE attachments/{id}`, then the mirror row and the blob-store copy (section 4.6) |
| `theme_image.delete` | — | Server only (section 4.8): the image and its bytes. `rejected` with `theme_image_in_use` while a list or smart list uses it |
| `settings.update` | any subset of: `my_day`, `important`, `planned`, `all`, `completed` | Server only (section 4.8). `sid` is the `app_settings` entity's `id` |

`position` is a property of the mutation itself, beside `fields`; every other name in the
Fields column goes in `fields`. A field that isn't listed for the op, including a parent
reference (`list_id`, `task_id`) on anything but a create or `task.move`, makes the whole
mutation `rejected` with `unknown_fields:<names>`. The server finds the parent of an
existing step or link from its `sid`.

Steps nobody has dragged have no order value (`order: null` in the feed), and the app
shows them oldest first, below any ordered steps. Before a `step.reorder`, the server
gives every other unordered step of that task an order value in that shown order, so
the move has neighbors and nothing else appears to move. It costs one Substrate write
per unordered step, once per task.

A list's `theme` is written as `{ "color": name }`. Only the color is writable, and only
a name To Do renders: `blue` (every new list's value), `purple` (seen in To Do web) and
iOS To Do's 14 swatches,
in its picker order `dark_blue`, `dark_purple`, `dark_rose`, `dark_red`, `dark_green`,
`dark_teal`, `dark_grey`, `light_blue`, `light_purple`, `light_rose`, `light_red`,
`light_green`, `light_teal`, `light_grey`. Substrate stores any string, and To Do shows a name it doesn't know as no
theme at best, so any other name, a `background`, `null` or `""` is rejected with
`invalid_field:theme`. A color-only write keeps the list's background. `group_id` is a group's
`sid` from the feed, or `null` to take the list out of its group; an unknown group sid is
`rejected` with `unknown_list_group`. A `list.reorder` reference is a list or a group in
the list's own container: for a list in a group, another list in that group; for a
top-level list, another top-level list or a group. Any other reference is `rejected` with
`reference_not_sibling`. The default list can't be grouped or moved (`default_list`).
A group's `name` is any non-empty text. These ops, and the `list_group` ops, need
`capabilities.list_appearance_write`; without it they are `rejected` with
`list_appearance_unavailable`, or, on a server older than these writes, with an
unknown field or op. A server that reports `list_appearance` but not
`list_appearance_write` sends groups, order and theme in the feed and accepts none of
these edits.

`position` is `{ "before": sid }`, `{ "after": sid }`, `{ "top": true }` or
`{ "bottom": true }`. The server converts it to an order value with the existing
reorder math, using its own view of the neighbors. Sending neighbors rather than raw
order values keeps To Do's descending-`OrderDateTime` encoding out of the app, so the
encoding can change after Graph without an app update.

A list's `image_id` is a theme image's `id` (section 4.8), or `null` to remove the
image, and `image_style` is how it is shown (section 4.8). Each has its own field
clock. They are stored by this server and never sent to To Do, so they need
`capabilities.theme_images` rather than `list_appearance_write`; without it they are
`rejected` with `theme_images_unavailable`. An unknown or deleted image is `rejected`
with `unknown_theme_image`. A `list.update` may combine them with any other field.

Each `settings.update` field is one smart list's theme, `{ "color": name or null,
"image_id": id or null, "image_style": style or null }` (a key left out is `null`), or
`null` for the app's default. The value replaces the
smart list's whole theme, and each smart list has its own field clock (section 6), so
two devices that change different smart lists don't overwrite each other. A bad
`color` or a value of another shape is `rejected` with `invalid_field:<key>`; an unknown
image with `unknown_theme_image`.

Attachments are uploaded through a separate endpoint (section 5.6), not this batch,
because the body is binary. They are deleted here, with `attachment.delete`.

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
| `rejected` | Will never succeed: validation error, unknown `sid`, entity deleted, or `list_excluded` (it touches an excluded list, section 1.2). `error` names the reason. | Drop, and revert the local change by pulling. |
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
step 2. A plain retry would create a second item. A create whose earlier attempt may
have reached Graph first looks for what it made, and adopts it under the app's `sid`
if exactly one item matches:

| Create | Matched by |
| --- | --- |
| `task.create` | same title in the target list, created after the earlier attempt began |
| `step.create` | same title on the task, created after the earlier attempt began |
| `link.create` | `externalId` equal to the `sid` (the server sets it on every link the app creates) |
| `list.create` | same name, and first seen by the server after the earlier attempt began or not seen yet (lists have no creation time) |

More than one match is `rejected` with `ambiguous_create`; the app shows it to the
owner. An update or delete is safe to repeat as-is.

### 5.5 Where the code lives

The MCP tool handlers in `register-tools.ts` (about 4,800 lines) are closures bound to
`McpServer`. Neither this API nor ROADMAP §1 can reuse them as they stand. The first
build step extracts the write logic into `src/core/ops/` — plain functions taking a
`GraphClient`, an optional `SubstrateClient`, and the index — and makes the MCP tools
call them. Existing MCP tests guard the refactor. The sync mutation handler and the
§1 routes then call the same functions, so the three surfaces can't drift.

### 5.6 Uploading an attachment

```
POST /api/v1/attachments?task_id=<task sid>&sid=<new attachment sid>&name=<file name>
Authorization: Bearer <access token>
Content-Type: <the file's type>
<the file's bytes>
```

The body is the file itself, at most 25 MiB, To Do's limit. The server attaches it to
the task through Graph: in one request up to 3 MB, otherwise through an upload
session. With a blob store it also keeps a copy (section 4.6). The task then arrives
in the feed with the new entry in its `attachments`, and the push socket announces it.

- `sid` is the new attachment's `sid`, chosen by the app (a UUID), as for any create.
  It is also what makes a retry safe: sending the same upload again with the same
  `sid` returns the first result without attaching the file twice. A retry after a
  failure that may have reached Graph adopts an attachment of the same name and bytes
  that the first attempt made.
- `name` is the file name To Do shows, 1 to 255 characters after the server removes
  control characters and path separators.
- `Content-Type` is stored as sent when the server can't tell the type from the
  bytes. A recognised type in the bytes wins.

The response has the shape of a mutation result (section 5.3):

| Status | Body |
| --- | --- |
| 200 | `{ "status": "applied", "sid": "…", "cursor": "…" }`, or `"status": "duplicate"` for a repeat |
| 400 | `{"error":"bad_request","detail":"…"}`: a missing or malformed parameter |
| 404 | `{"error":"unknown_task"}` |
| 409 | `{"error":"list_excluded"}`, `{"error":"sid_in_use"}` or `{"error":"in_progress","retry":true}` |
| 413 | `{"error":"too_large"}` |
| 502, 503 | `{"error":"graph_…","retry":…}`, as for a download (section 4.6) |

`capabilities.attachment_upload: true` says the server has this route.

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
- After any change: `{"type":"changed","cursor":"k3v9.18461"}`. The first change after
  a quiet spell is sent at once. Changes in the next 3 seconds are held and sent as one
  message with the newest cursor when the 3 seconds end, so a burst sends at most one
  message every 3 seconds. One edit can still send two: the write itself, then values
  the server learns a second or two later (Substrate's manual order, the first fetch of
  a new task's steps and links). The app pulls on each and coalesces any that arrive
  while a pull is running.
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
`/.well-known/apple-app-site-association` listing the app under the `webcredentials`
service, which `ASWebAuthenticationSession` checks for an `https` callback. A static
page is enough; this server also serves the file when `APPLE_TEAM_ID` and
`APPLE_BUNDLE_IDS` (comma-separated) are set, as `{"webcredentials":{"apps":["<team>.<bundle>", …]}}`
with `application/json` and no redirect. Unset, the path is a 404. The callback is deliberately **not** on each server's host: Associated Domains
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

**Keeping an app token out of MCP, and an MCP token out of the sync API** (revised
after review, section 18.1). The earlier version of this paragraph said the library
accepts an `/mcp` token on every API route; that was wrong. In 1.2.3 the constructor
refuses an API route outside the canonical resource (`assertRouteCoveredByResource`),
and a token is accepted only on its own resource and its path descendants
(`audienceMatches`). So separation comes from **audience binding**, not a scope:
the provider moves to the library's role-based form (`OAuthAuthorizationServer` with
`resources: [<origin>/mcp, <origin>/api/v1]`, one `OAuthResourceServer` each). Claude's
connectors keep `<origin>/mcp` tokens; the app requests `resource=<origin>/api/v1`. A
token for one is refused by the other. The `sync` scope is dropped. **Before build:**
test that existing `/mcp` grants survive the change (the library keeps
`legacyGrantResource` for this).

### 8.1 Cloudflare Access in front of the app

**Status: built, off by default.** The server-side half is in the code
(`src/core/auth/access.ts`, `src/hosts/shared/app-signin.ts`). It stays off until the
owner sets `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`; with neither set, every path behaves
as it did before. The Access application itself is account configuration, which the
owner sets up (see **Turning it on** below).

On deployments that use it (section 16), Access is a second, independent gate: a request
must pass Access at the edge and then present a valid OAuth token for the `/api/v1`
resource. Neither layer trusts the other. The server also checks the Access token
itself, so a gap in the Access application's paths fails closed instead of open.

**Which paths Access covers.** One Access application on this hostname, with these
paths:

- `/api/v1/*` — every sync API path, including `/api/v1/sync/info`,
  `/api/v1/sync/socket` and `/api/v1/attachments/*`.
- `/app/signin` — the app's sign-in path (below).

These paths stay **outside** Access, because their callers can't complete an Access
login: `/mcp`, the OAuth endpoints (`/authorize`, `/auth/microsoft/callback`, `/token`,
`/register`, `/.well-known/oauth-*`), `/webhook` (Microsoft Graph), the single-use-link
`/upload` and `/download`, `/health`, and `/.well-known/apple-app-site-association`.

The anonymous `GET /api/v1/sync/info` probe is behind Access too. An app that probes a
server before signing in gets Access's login redirect instead of `{ server_id }`, which
is how it learns that Access is in front (section 16).

**What the server checks.** With Access configured, every `/api/v1` request, including
the WebSocket upgrade on both hosts, must carry an Access JWT that passes all of these
checks. The server checks them before the OAuth token, and refuses with `403
{"error":"access_denied"}` otherwise. When the team's keys can't be fetched, it answers
`503 {"error":"access_unavailable"}` with `Retry-After: 30` instead, so the app retries
rather than signing in again.

- RS256 signature by a key from `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`.
  The server caches the keys for an hour. A token signed by an unknown key ID triggers a
  refetch, at most once a minute. The fetch follows no redirects and times out after 5
  seconds. If a refetch fails, keys fetched in the last 24 hours keep working.
- `iss` is `https://<team>.cloudflareaccess.com`, and `aud` contains `ACCESS_AUD`.
- `exp` and `nbf` hold, with 60 seconds of clock skew.
- `email` equals `OWNER_EMAIL`, ignoring case. Service tokens carry no email, so they
  never pass.

The server reads the token from `Cf-Access-Jwt-Assertion` (added by Access to every
request it lets through) or, failing that, from the `cf-access-token` header the app
sends. Only the first one present is checked. It never trusts
`Cf-Access-Authenticated-User-Email` on its own, and it never logs a token or its
claims, only the reason for a refusal.

If only one of `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` is set, the server treats Access as
misconfigured: every gated path answers `503 {"error":"access_misconfigured"}`.

**How a native app passes Access.** Access accepts its session token in a
`cf-access-token` request header, which is how non-browser clients call
Access-protected APIs. The app gets that token during sign-in:

1. The app opens `https://<host>/app/signin?<its OAuth authorization parameters>` in
   `ASWebAuthenticationSession`: `response_type=code`, `client_id`, `redirect_uri`,
   `state`, `code_challenge` with `code_challenge_method=S256`, and
   `resource=<origin>/api/v1`. That path is behind Access, so the session shows the
   Access login first.
2. The server verifies the Access JWT as above. In a browser it also accepts the
   `CF_Authorization` cookie when the assertion header is absent. It refuses the request
   (400) when `resource`, `client_id`, `redirect_uri` or `code_challenge` appears more
   than once, or when `redirect_uri` isn't listed exactly in
   `ACCESS_HANDOFF_REDIRECT_URIS`. It then stores the
   Access token for ten minutes, sealed, bound to the request's `client_id`,
   `redirect_uri` and PKCE challenge, puts a handle to it in a `__Host-` cookie, and
   redirects to `/authorize` with the same parameters.
3. The authorization runs as it does for every client: consent page, Microsoft sign-in,
   `OWNER_EMAIL` gate. **The Microsoft step is kept.** A verified Access identity does
   not skip it, so the owner gate (UPN or object ID, identity-change wipe, grant epoch)
   is the same code for the app as for every MCP connector, and Access stays an extra
   gate rather than a replacement identity. With Entra as the Access identity provider,
   the Microsoft step is usually silent.
4. At the Microsoft callback, if the handle's record matches the authorization being
   completed and its redirect URI is still in `ACCESS_HANDOFF_REDIRECT_URIS`, the new
   grant carries the handle. When the app redeems the code at
   `/token`, the response adds two fields, and the grant keeps no trace of the token:

   ```json
   { "access_token": "…", "refresh_token": "…", "cf_access_token": "<Access JWT>", "cf_access_expires_at": 1795563933 }
   ```

   The Access token never appears in a redirect URL (section 18.7). The library has
   already checked the code, the PKCE verifier and the exact `redirect_uri` by then. A
   refresh doesn't return `cf_access_token`.
5. The app sends `cf-access-token` and `Authorization: Bearer` on every request,
   including the WebSocket upgrade. When Access answers with its login redirect instead
   of the API response, or `cf_access_expires_at` has passed, the session has expired
   and the app repeats sign-in. If the identity provider's session is still valid, that
   completes without a prompt.

Without Access configured, `/app/signin` is a 404 and the token response has no
`cf_access_token`. The app then signs in at `/authorize` directly.

**Not verified yet, because it needs a live Access application:**

- That Access accepts the `Cf-Access-Jwt-Assertion` value, which the server hands over,
  in the `cf-access-token` header. Cloudflare documents that flow with the
  `CF_Authorization` token; the two are expected to be the same application token.
- That Access adds `Cf-Access-Jwt-Assertion` to the WebSocket upgrade it proxies.
- How long the Access session lasts for this application (the application's session
  duration setting).

**Passkeys instead of emailed codes.** Access's one-time PIN is the emailed code.
Replacing it is an Access configuration change, not server code: add Microsoft Entra
ID as the Access identity provider and remove one-time PIN from this application. Entra
supports passkeys as a sign-in method, so a passkey stored in 1Password signs in to both
Access and the OAuth flow's Microsoft step, which is the same account the `OWNER_EMAIL`
gate already checks. Confirmed 2026-11-23: Microsoft sign-in with a passkey stored in
1Password works on this tenant.

**Turning it on.** The owner does these steps in the Cloudflare dashboard and the
deployment's configuration. Nothing in the repository does them.

1. In Zero Trust, add Microsoft Entra ID as an identity provider (Settings →
   Authentication).
2. Create a self-hosted Access application on the server's hostname with the paths
   `/api/v1/*` and `/app/signin`. Don't add `/mcp`, the OAuth endpoints, `/webhook`,
   `/upload`, `/download` or `/.well-known/*`.
3. Give it one Allow policy that includes only the owner's email, and allow only the
   Entra identity provider (remove one-time PIN).
4. Copy the application's audience (AUD) tag from its overview.
5. Set `ACCESS_TEAM_DOMAIN` (`<team>.cloudflareaccess.com`) and `ACCESS_AUD` on the
   Worker, as vars in `wrangler.jsonc` or as secrets. `OWNER_EMAIL` must be the email
   Access reports for the owner.
6. Set `ACCESS_HANDOFF_REDIRECT_URIS` to the app's exact callback URI, for example
   `https://todo-app.<your domain>/oauth/callback` (comma-separated if there are
   several). Only these redirect URIs receive the Access token. Without this variable,
   `/app/signin` refuses every request, so a consent page approved for some other client
   can never hand that client the owner's Access token.
7. Deploy. Check that `GET /api/v1/sync/info` without a session redirects to the Access
   login, and that `/mcp` and `/.well-known/oauth-authorization-server` still answer
   without one.

On the Node host the same variables apply, with Cloudflare Tunnel and Access in front.

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

- The OAuth provider moves to the library's role-based form, with `/mcp` and
  `/api/v1` as separate resources (section 8, 18.1). The grant check runs in both.
- A static `HTTP_API_TOKEN` for n8n enters through the provider's
  `resolveExternalToken` hook, compared in constant time, and is valid only for the
  `/api/v1` routes n8n uses, never the sync routes (to verify: how the role-based form
  exposes `resolveExternalToken`). Cloudflare Access service tokens, the other §1 option, are
  checked at the edge before the Worker runs and need no code here.
- `router.ts` is in `src/core`, so both hosts get it. On Node it is mounted in
  `createHandler`, behind the existing body caps.

Building the §1 routes isn't part of this work. Only the shared router, auth layer and
`ops/` extraction are, and they make §1 a matter of adding route files.

---

## 10. After Graph: the gap list

This section is design only, except section 10.4, whose Graph-mode half (a read-only
mirror of list groups and sidebar order) is built. Nothing else here is built until
the switch is near.

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

The blob store (section 4.9) is the `BlobStore` port in `ports.ts`: R2 on Cloudflare.
While Graph is the source it holds a copy of each attachment downloaded or uploaded
through this server (section 4.6). Before the switch, a migration copies every
remaining attachment's bytes into it, after which it is the only copy. The Node host
has no blob store yet.

### 10.3 IDs for new items

Already solved by section 2: the `sid` is the primary key in both modes.

### 10.4 List groups and sidebar order

**Built in Graph mode.** Graph exposes neither groups nor sidebar order. Substrate does
(see the spike results), so the server mirrors them from Substrate and serves them in
the change feed. The app changes a list's theme and group with `list.update` and its
position with `list.reorder` (section 5.2), and creates, renames, moves and deletes
groups with the `list_group` ops. Each writes the folder or group in Substrate, and the
server stores it as Substrate returns it, so the change is in the feed at once. A
group's `position` is among the top-level lists and the other groups, like a top-level
list's; the reference is a list or a group sid.

Observed on the Servant Voice account (2026-11-25): Substrate accepted `ThemeColor`,
`ThemeBackground`, `ParentFolderGroupId` (a group's `Id`, or `null` to ungroup) and
`OrderDateTime` in one `PATCH taskfolders/{id}`, and returned the whole folder. It
ignored `null` for a theme value and stored `""` as given. It keeps a list's
`OrderDateTime` to the whole second (groups keep milliseconds), so the server writes
whole seconds and refuses a move with `order_precision_exhausted` when no whole second
lies between the neighbors. Moving a list into a group
through Substrate leaves its `OrderDateTime` unchanged, unlike a drag in To Do, which
gives it a new one; send a `list.reorder` after the `list.update` to place it.
`POST foldergroups` with `Name` and `OrderDateTime` made a group with both, and `PATCH
foldergroups/{id}` changed either. `DELETE foldergroups/{id}` deleted an empty group
and refused one that still held a list with a 400, so `list_group.delete` moves the
lists out first, reading the group's lists from Substrate rather than the mirror, which
can lag a move made in To Do. A list moved out keeps its `OrderDateTime` and lands
among the top-level lists by it. A rename made in To Do carries no field clock, so a
queued `list_group.update` older than it still applies.

**What the server reads.** One read is two Substrate GETs:

- `GET {substrate}/todob2/api/v1/taskfolders?$select=Id,OrderDateTime,ParentFolderGroupId,ThemeColor,ThemeBackground`.
  If Substrate refuses the `$select` with a 400, the server asks again without it.
- `GET {substrate}/todob2/api/v1/foldergroups`. Each group has `Id`, `Name` and
  `OrderDateTime`.

Both follow `@odata.nextLink` for up to 10 pages. The server stores a read only when
it is complete: a collection longer than 10 pages, a response without a `value`
array, or one item that doesn't parse fails the whole read, so a malformed answer
can't delete groups. An `OrderDateTime` sent as a `{ DateTime, TimeZone }` object is
stored as one ISO string. If a folder names a group that the group read didn't
return, the server keeps every stored group for that read rather than delete one
still in use. The server matches each folder to
a list by `Id`, which it expects to equal the Graph list ID.

**What it stores** (migration v12): on each `lists` row, `group_id` (the group's
Substrate `Id`), `order_datetime`, `theme_color` and `theme_background`; and a
`list_groups` table (`group_id`, `name`, `order_datetime`). Triggers log a changed
list, and log each group as a `list_group` entity with its own `sid` and deletion
record, the same way lists are logged (section 3.2). Excluded lists get their
appearance stored too; the feed leaves them out as before (section 1.2).

**What the feed sends** (section 4.2):

| Field | Meaning |
|---|---|
| list `group_id` | The group's `sid`, or `null`. |
| list `sort_key`, group `sort_key` | `OrderDateTime` exactly as Substrate sends it. `null` for the default list. |
| list `theme.color`, `theme.background` | `ThemeColor` and `ThemeBackground` exactly as Substrate sends them. A value that isn't a string is sent as its JSON. |

Observed on a live account (2026-11-24): both theme values are preset names, for
example `"color": "blue"` and `"background": "mountain"`. The app maps each name to its
own color or image, and treats a name it doesn't know as "no theme". The order values
are ISO 8601 instants but not all in one form: some carry milliseconds
(`2026-11-23T23:45:45.623Z`) and some don't (`2026-11-23T23:45:47Z`). Parse them as
instants before comparing; comparing the strings puts some in the wrong order.

**Sidebar order.** A later `sort_key` is nearer the top, the same direction as tasks.
Groups and top-level lists share one ordering, and lists inside a group are ordered the
same way within it. The default list (`sort_key` `null`) isn't part of this order: To Do
shows it at the top with the smart lists. Confirmed on 2026-11-24 against the To Do web
sidebar of a test account: a group keyed `…45:49.248Z` sat above a group keyed
`…45:45.623Z`, which sat above a list keyed 2026-05-19.

The full set of theme names isn't known yet.

Collapsed or expanded state isn't stored by Microsoft. The app keeps it locally.

**When the server reads.** On a calm sync cycle (no baseline still paging), when
either is true:

- a list has never been read: a new list, or every list after migration v12;
- the last successful read is at least `DELTA_SYNC_INTERVAL_MIN` old.

Moving a list or changing its theme doesn't change the list in Graph's roster delta,
so the interval is what picks those changes up. A read costs two subrequests, plus a
token mint when the cached Exchange Online token has expired.

**Without Substrate.** When `ENABLE_MY_DAY` is off, or Microsoft refuses the Exchange
Online scope, the server makes no read: the columns stay `null` and
`capabilities.list_appearance` is `false`. A 403 from Substrate on either read turns
off only list appearance for that identity (until the object restarts), and
`list_appearance` becomes `false`; My Day and step order keep working. Any other failure,
including a 429, which the read doesn't retry, keeps the stored values, is recorded in
`sync_state` (`meta:appearance`), and backs off: the next read waits one sync
interval, then twice that after each further failure, up to 6 hours. A read that
overlaps an owner change writes nothing. A failed read never fails the sync cycle.

**After the switch** (`SYNC_SOURCE=local`), groups, order and theme become app-owned:
the same columns and entities, written by the app's mutations.

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

1. **Spike** (done; results at the end of this document).
2. **Foundations from the review:** a `transaction(fn)` port on both hosts; one
   atomic `IndexCore.moveTask`; the delta-overwrite guard; the switch to immutable task
   IDs, re-baselined, with subscriptions recreated (section 18.2). Lands before v4 so
   the change log starts on immutable IDs.
3. **Migration v4:** `entity_map`, `sync_log` (with `list_sid`), triggers,
   `field_clock`, mark-and-sweep for `resync`/410, and `Props.principal` on new grants
   (section 15.2). No API yet; tests assert log rows for every writer.
4. **Mirror completeness:** body columns, `linked_resources`, `attachments`, step
   order, the generalized sub-resource scan with backfill mode, the per-list sync
   setting (section 1.2; was the `archive` list policy).
5. **`ops/` extraction** from `register-tools.ts`, plus the single mutation queue in
   `IndexCore` (section 18.4). MCP behavior unchanged.
6. **Router and auth:** `/api/v1` mount on both hosts, role-based resources (section
   18.1), the Access
   sign-in path, `GET /sync/info`, `GET /sync/changes` with `scope`, `GET /tasks/{sid}`, `GET /search`.
7. **`POST /sync/mutations`** with idempotency and field clocks.
8. **WebSocket push** on both hosts, plus hot-list-first sync.
9. **End-to-end check:** a script holds a WebSocket to the deployed Worker, I edit a
   task in Microsoft To Do, and the script reports the time from the webhook log line to
   the `changed` message, then confirms `/sync/changes` returns the edit.

---

## 13. Decisions from review

Answered 2026-11-23:

1. **Unmirrored lists** are kept, shown only in an archive area of the app. Superseded
   2026-11-24 by the per-list sync setting (section 1.2).
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
    "capabilities": { "my_day": true, "step_order": true, "sub_resources": true,
                      "list_appearance": true, "list_appearance_write": true,
                      "attachment_download": true, "attachment_upload": true,
                      "attachment_cache": true, "theme_images": true,
                      "push": "websocket",
                      "source": "graph" },
    "link_rules_rev": "9f2c4e01a7b3d5e6"
  }
  ```

  `server_id` is a random ID created once and stored in DO storage. It never changes,
  unlike the cursor epoch, which changes on an identity reset. The app keys the
  account's local data by it, so re-adding the same server is recognized.
  `capabilities` tells the app what this server supports: a deployment without the
  Exchange Online scope has no My Day, no step order and no list appearance
  (`list_appearance`: sidebar groups, order and theme in the feed, section 10.4;
  `list_appearance_write`: changing them, section 5.2), and a deployment whose
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

- 2026-11-26: sections 4.6, 4.8, 4.9, 5.2 and 5.6: a blob store (R2). Attachment
  downloads are kept in it; `POST /api/v1/attachments` uploads a file and
  `attachment.delete` removes one. Theme images (`POST`/`GET /api/v1/theme-images`, the
  `theme_image` kind), a list's `image_id`, and smart-list themes in the
  `app_settings` entity with `settings.update`; `image_style` on lists and smart-list
  themes. New capabilities `attachment_cache`,
  `attachment_upload` and `theme_images`.
- 2026-11-25: section 7.1: `changed` messages are coalesced: one at once, then at most
  one per 3 seconds while changes keep coming. Measured on the Servant Voice server, a
  `task.create` went from three messages to two.
- 2026-11-25: sections 5.2 and 10.4: `list_group.create`, `list_group.update`,
  `list_group.reorder` and `list_group.delete`; groups are no longer read-only.
- 2026-11-25: sections 5.2 and 10.4: `list.update` takes `theme` and `group_id`, and
  `list.reorder` moves a list in the sidebar. New
  `capabilities.list_appearance_write` says the server accepts these edits. A theme write
  sets the color only, from the names To Do renders (`blue`, `purple` and the 14 iOS swatches).
- 2026-11-25: section 5.2: `step.reorder` gives a task's unordered steps order values in
  their shown order before the move, instead of failing with `reference_has_no_order`.
- 2026-11-25: section 4.7 added: `GET /api/v1/link-rules` and `link_rules_rev` in
  `/sync/info`, so the app can mark link-rule matches before the server makes the link.
- 2026-11-25: section 5.2's table split into one row per op, with the fields the server
  accepts. The shared rows had implied that `step.update`, `step.delete`, `link.update`
  and `link.delete` take `task_id`; the server rejects it. `myday.remove` ignores
  `position`.
- 2026-11-25: section 10.4's open question on sidebar order closed: a later
  `sort_key` is nearer the top, groups and lists sharing one ordering.
- 2026-11-24: section 10.4 built read-only. Lists in the feed carry `group_id`,
  `sort_key` and `theme`; a new `list_group` kind; `capabilities.list_appearance`.
- 2026-11-24: section 8.1 rewritten for what is built: the server-side Access check on
  `/api/v1` and `/app/signin`, the token hand-over at code redemption, the
  Apple association file, and the owner's steps to turn Access on.
- 2026-11-24: section 1.2 replaced. The `archive` sync policy and the separate list
  classification became one per-list setting (`todo` / `reference` / `excluded`), with
  `sync` on feed lists, `list.update { sync }` and `GET /api/v1/lists/excluded`.
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
- 2026-11-23, SV: re-parenting **by immutable ID** works. Substrate moved the task and
  confirmed the destination, the immutable ID resolved in the destination list
  afterward, and the test task was deleted. Two details for the ID switch: Substrate's
  response carries the task's new **plain** ID (`AAMk…`), so code that re-keys from
  `reparentTask`'s returned `Id` (today's `move_task`) must stop doing that; and a
  Graph GET of the immutable ID under the **old** list returns `400`, not `404`.

---

## 18. Revisions from the Fable review (2026-11-23)

An independent review (Claude Fable, reading the code) found these. Each changes the
design above; where an earlier section said otherwise, this section wins.

### 18.1 Auth: audience binding, not a scope
Section 8 is corrected in place. The library binds each token to one resource, so the
app and the MCP connectors get separate resources and the `sync` scope is dropped. It
would have been weak anyway: `scopesSupported` is unset and the authorization handler
grants whatever scopes a client asks for (`auth-handler.ts`). The existing `/mcp`
grants must be shown to survive the switch to the role-based provider before it ships.

### 18.2 Immutable task IDs: how to switch safely
- **Substrate returns plain IDs.** The My Day scan writes by Substrate's `t.Id`
  (`index-core.ts`, `#runMyDayScanBatch`), and `move_task` re-keys from the
  re-parent response's `Id`. Against an immutable-keyed mirror the first would
  silently write nothing (My Day empties) and the second would add a duplicate row.
  Fix: translate at the Substrate boundary (batch `translateExchangeIds` per scanned
  folder, or send the `Prefer` header to Substrate if it honors it — untested), and
  make a move an atomic `IndexCore.moveTask` that changes `list_id` and ignores the
  returned ID.
- **Step reorder** matches Substrate `Subtasks[].Id` to Graph checklist item IDs.
  Untested: whether checklist item, linked resource and attachment IDs change form
  under the header. Test before switching.
- **Migration:** its own step, before v4 creates the triggers. Drop task rows and every
  `tasks:*` delta link, re-baseline with the header (a delta link issued without it may
  keep returning plain IDs — untested), and recreate Graph subscriptions with the
  header so a notification's `resourceId` matches the mirror (inference: today's
  subscriptions send plain IDs). Run it before the sub-resource backfill, because a
  re-baseline currently nulls every task's backfill marker.
- **MCP callers holding plain IDs:** on a mirror miss, translate once at the tool
  boundary. `previous_task_id` stays in `move_task`'s output and now equals `task_id`.
- **Errors:** a task looked up under a list it has left now returns `400`, not `404`.
  `#recheckSource` already treats that as "unknown → treat as moved" (safe); the
  `task_not_found` mapping needs the inner error code, and the list should be resolved
  from the mirror by task ID.
- **Test:** which ID a completed recurring instance keeps.

### 18.3 The task is the unit of sync
With per-device scope (section 4.5) and later sharing, a step logged separately from its
task can sit below the cursor while its task is out of scope, and never arrive when the
task comes back. So steps, links and attachment metadata are embedded in the task entity
(section 4.2 example is updated), and a change to any of them bumps the parent task's log
row. This also removes the parent-before-child rule in section 4.3 for those kinds; lists
remain separate entities. `entity_map` still gives each child a `sid` so edits can name
it.

### 18.4 Serializing writes
Every Graph call yields the Durable Object's input gate, so a retried batch, a second
device or an MCP tool can interleave with a running batch. One write queue in
`IndexCore` (modelled on `#refreshChain`) carries sync mutations and MCP writes alike. A
`pending` idempotency row gets a lease: a retry that finds a live lease waits or returns
`skipped`; an expired lease is re-checked before re-running. Batches are capped at 25 with
a time budget (section 5.1).

### 18.5 Atomicity and stale writes
- **A `transaction(fn)` port** on both hosts. `SqlDb` has only `exec`, and the Node host
  autocommits each statement, so "the same transaction" in section 5.4 had no mechanism.
- **Delta can't overwrite a newer write-through.** A delta page fetched before a
  write-through lands would revert it, and the feed and `field_clock` would record the
  old value. The delta upsert is guarded by `excluded.modified_at >= tasks.modified_at`.
- **Create adoption by title and time is ambiguous**, and doesn't cover step or link
  creates or the copy-and-delete move. Test Graph open extensions on `todoTask` for
  stamping the `sid` at create time.
- **Replaying a completion** of a repeating task may complete the next occurrence if
  the ID moves with it. Test before treating updates as safe to repeat.

### 18.6 Change-log details
- The `sid` mint and the log write go in **one trigger** with two statements; SQLite
  doesn't guarantee the order of separate triggers on the same event.
- `replaceChecklistItems` deletes and re-inserts every step on each scan; it changes
  to a diff, so unchanged steps log nothing.
- `deleteList` leaves the list's steps behind; it cascades to them.
- **Mark and sweep:** rows written through during a multi-cycle baseline carry the
  baseline's generation so the sweep keeps them. The roster-level 410 (which today drops
  every task) gets its own handling. The backfill marker is nulled only when a task's
  `modified_at` changed, so a re-baseline doesn't re-run the whole backfill.
- **Restores:** a cursor whose `seq` is above the current maximum gets `410`, and the
  restore runbook rotates the epoch. With scope filtering, the returned cursor is the
  last `seq` scanned, not the last one sent.

### 18.7 Security
- `GET /sync/info` before sign-in returns only what sign-in needs (that the server
  exists, its `server_id`, and whether Access is in front); name, email hint and
  version need a token. Built: the probe answers `{ server_id }` only, and when Access is
  configured the probe is behind it, so the Access redirect is the "Access is in front"
  answer (sections 8.1 and 16).
- The Access token is not put in a redirect URL. The server holds it and hands it
  over at code redemption, bound to the app's exact redirect URI. Built as
  `cf_access_token` in the `authorization_code` token response (section 8.1).
- The Node WebSocket upgrade validates with the library's resource-checking validator,
  not `unwrapToken`, which checks neither audience nor scope.
- A socket is bound to its grant and epoch and has a lifetime cap, rather than being
  checked only when an announcement goes out.
- Task bodies are raw HTML, and archived flagged-email tasks hold email content. The
  app renders bodies sanitized, with no remote loads.

### 18.7a Correction: production mirrors flagged email
Sections 1 and 1.2 describe `flaggedEmails` as not mirrored. That's the default, but
this deployment opts in (`sync_flagged_emails`), and on 2026-11-24 production held
13,296 tasks, 10,247 of them in Flagged Emails. Two consequences:
- **The sub-resource backfill is about five times the section 1.1 estimate** if it
  covers flagged email. Flagged-email tasks carry a linked resource (the message link)
  and rarely steps. Proposal: when the list is `reference`, backfill only its open tasks,
  and fetch a completed one's sub-resources on demand (`GET /api/v1/tasks/{sid}`).
- **The iPhone's `active` scope** includes every open flagged email. How many are open
  is unmeasured; a `query_tasks` count on that list answers it before the app is built.

### 18.7b Open question: what happens to flagged email (2026-11-24)
The Flagged Emails list is To Do's view of Outlook message flags. Once Graph's To Do
API is off, the mirrored copy goes stale, and only a mail integration can keep it
current. Two options, undecided:
1. **Drop it at the switch.** Keep at most a read-only snapshot; the app stops showing
   flagged email.
2. **A separate mail source.** Read flags from Graph mail (`message.flag`: status,
   start, due, completed), keep them current with mail change notifications, and set or
   clear a flag with `PATCH /me/messages/{id}`. Graph's mail API doesn't depend on To
   Do, so this survives the retirement. Cost: it needs `Mail.Read` to read flags and
   `Mail.ReadWrite` to change them — read and write access to the whole mailbox, since
   Graph has no flag-only permission. It would also give the MCP tools email-flag
   abilities none of the current connectors have.

If built, it may live in a **separate Worker** with its own Entra app registration
(David, 2026-11-24). That keeps the mailbox-wide token out of the task server and out of
its MCP connectors; the task server would consume it as one more source.

Until decided: keep mirroring through To Do, set the list to `reference`, and don't
backfill its sub-resources. Design the app's flagged-email area as one more source
behind the same feed, so either option fits without app changes.

### 18.8 Later
- Expose the `sid` in MCP outputs and accept either ID form now, so the after-Graph
  switch doesn't change MCP IDs a second time. Write the switch as a one-way procedure:
  final drain, subscription teardown, snapshot.
- Sharing needs a per-list deletion record: one compacted row can't tell a member of
  list A that a task moved to list B, which they can't see.
- Measure the one-GET `$expand=checklistItems,linkedResources` and Substrate step-order
  cost, and throttling, before raising the backfill budget.

