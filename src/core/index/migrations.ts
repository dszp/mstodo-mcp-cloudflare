// Per-version schema deltas, applied in order. New DBs run the bootstrap
// SCHEMA_DDL (the original shape) and then this ladder brings them — and any
// existing DB — up to the latest version. Each migration is gated by a stored
// version so an ALTER never runs twice.
//
// NOTE: PRAGMA user_version is NOT authorized in Workers DO SQLite
// (SQLITE_AUTH), so the schema version is tracked in a single-row schema_meta
// table instead.
//
// To add a migration: append a new entry with the next sequential version.
// Order matters; do not edit historical entries.

import type { SqlDb } from "../ports";

interface Migration {
  version: number;
  apply: (sql: SqlDb) => void;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    apply: (sql) => {
      // Substrate-only fields the cache now owns. Nullable — back-fill is a
      // later task's job (background scan / write-through); no synthetic
      // values written here.
      sql.exec("ALTER TABLE tasks ADD COLUMN committed_day TEXT");
      sql.exec("ALTER TABLE tasks ADD COLUMN committed_order TEXT");
      sql.exec("ALTER TABLE tasks ADD COLUMN order_datetime TEXT");
      // PostponedDay = bare date (YYYY-MM-DD). With CommittedDay set and
      // PostponedDay == that same day, the app suppresses the task from My Day.
      sql.exec("ALTER TABLE tasks ADD COLUMN postponed_day TEXT");
      // Hot path for the My Day read query; narrows to the right day.
      sql.exec("CREATE INDEX IF NOT EXISTS tasks_committed_day ON tasks(committed_day)");
      // Make the FTS update trigger column-specific so background-scan writes
      // (committed_*, order_datetime, postponed_day) don't churn the FTS index.
      sql.exec("DROP TRIGGER IF EXISTS tasks_au");
      sql.exec(`
        CREATE TRIGGER tasks_au AFTER UPDATE OF title, body_plain ON tasks BEGIN
          INSERT INTO tasks_fts(tasks_fts, rowid, title, body_plain)
            VALUES ('delete', old.rowid, old.title, old.body_plain);
          INSERT INTO tasks_fts(rowid, title, body_plain)
            VALUES (new.rowid, new.title, new.body_plain);
        END
      `);
    },
  },
  {
    version: 2,
    apply: (sql) => {
      // ROADMAP §4 — one row per active Graph change-notification subscription.
      // subscription_id is Graph's; list_id is the todoTaskList it covers;
      // client_state is the per-subscription secret echoed back in every
      // notification (authenticity check); expiration_ms drives renewal.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS subscriptions (
          subscription_id TEXT PRIMARY KEY,
          list_id         TEXT NOT NULL,
          client_state    TEXT NOT NULL,
          expiration_ms   INTEGER NOT NULL,
          created_at_ms   INTEGER NOT NULL
        )
      `);
      sql.exec("CREATE INDEX IF NOT EXISTS subscriptions_list ON subscriptions(list_id)");
    },
  },
  {
    version: 3,
    apply: (sql) => {
      // ROADMAP — checklist-item cache. One row per checklist item, joinable to
      // tasks by task_id, so checklist text/state is queryable ACROSS tasks
      // (today the cache holds only a single has_checklist 0/1 per task, itself
      // null on every delta upsert). is_checked is the open/closed flag; the
      // "waiting on X" follow-up use case sorts by the oldest open item.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS checklist_items (
          item_id      TEXT PRIMARY KEY,
          task_id      TEXT NOT NULL,
          list_id      TEXT NOT NULL,
          display_name TEXT,
          is_checked   INTEGER NOT NULL DEFAULT 0,
          created_at   INTEGER,
          checked_at   INTEGER
        )
      `);
      sql.exec("CREATE INDEX IF NOT EXISTS checklist_items_task ON checklist_items(task_id)");
      sql.exec(
        "CREATE INDEX IF NOT EXISTS checklist_items_open ON checklist_items(is_checked, task_id)",
      );

      // "needs (re)fetch" marker on tasks: NULL means "fetch this task's
      // checklist." Excluded from TASK_COLUMNS so the delta UPSERT never clobbers
      // it — same treatment as the Substrate committed_* columns (migration v1).
      sql.exec("ALTER TABLE tasks ADD COLUMN checklist_synced_at INTEGER");

      // External-content FTS over item text, mirroring tasks_fts (sql.ts:49-68).
      // Keyed to checklist_items.rowid; kept current by the three triggers below.
      sql.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS checklist_fts USING fts5(
          display_name,
          content='checklist_items', content_rowid='rowid',
          tokenize = 'unicode61 remove_diacritics 2'
        )
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS checklist_ai AFTER INSERT ON checklist_items BEGIN
          INSERT INTO checklist_fts(rowid, display_name) VALUES (new.rowid, new.display_name);
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS checklist_ad AFTER DELETE ON checklist_items BEGIN
          INSERT INTO checklist_fts(checklist_fts, rowid, display_name)
            VALUES ('delete', old.rowid, old.display_name);
        END
      `);
      // AFTER UPDATE OF display_name — so a check/uncheck toggle (is_checked only)
      // doesn't churn the FTS index.
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS checklist_au AFTER UPDATE OF display_name ON checklist_items BEGIN
          INSERT INTO checklist_fts(checklist_fts, rowid, display_name)
            VALUES ('delete', old.rowid, old.display_name);
          INSERT INTO checklist_fts(rowid, display_name) VALUES (new.rowid, new.display_name);
        END
      `);
    },
  },
  {
    version: 4,
    apply: (sql) => {
      // docs/SYNC-API.md section 18.2: task IDs switch to Graph's immutable form
      // (the GraphClient now always sends Prefer: IdType="ImmutableId"). Rows
      // and delta links stored under default REST IDs are dropped, so every
      // list re-baselines and every task is re-fetched with its immutable ID.
      // The My Day scan state is reset so it refills the Substrate fields. List
      // rows, subscriptions and config are kept: list IDs don't change form.
      sql.exec("DELETE FROM tasks");
      sql.exec("DELETE FROM checklist_items");
      sql.exec("DELETE FROM sync_state WHERE resource LIKE 'tasks:%' OR resource LIKE 'myday:%'");
    },
  },
  {
    version: 5,
    apply: (sql) => {
      // docs/SYNC-API.md sections 2, 3 and 18: the change log the sync API
      // serves. Written by triggers, so every writer is covered (delta, webhook
      // refreshes, scans, MCP write-throughs, and future app mutations).
      //
      // entity_map: a server-side stable ID (sid) per list, task and step.
      // Rows outlive their entity, so a re-inserted Graph ID keeps its sid.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS entity_map (
          kind       TEXT NOT NULL,
          sid        TEXT NOT NULL,
          graph_id   TEXT,
          created_ms INTEGER NOT NULL,
          PRIMARY KEY (kind, sid)
        )
      `);
      sql.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS entity_map_graph ON entity_map(kind, graph_id) WHERE graph_id IS NOT NULL",
      );
      // sync_log: one row per list or task; a change replaces the row, moving it
      // to a new, higher seq. Steps (and later links and attachments) don't get
      // rows of their own: a change to one bumps its task (section 18.3).
      sql.exec(`
        CREATE TABLE IF NOT EXISTS sync_log (
          seq      INTEGER PRIMARY KEY AUTOINCREMENT,
          kind     TEXT NOT NULL,
          sid      TEXT NOT NULL,
          deleted  INTEGER NOT NULL DEFAULT 0,
          list_sid TEXT,
          at_ms    INTEGER NOT NULL,
          UNIQUE (kind, sid)
        )
      `);
      // The cursor's epoch: replaced when every client must start over.
      sql.exec(
        "CREATE TABLE IF NOT EXISTS sync_meta (id INTEGER PRIMARY KEY CHECK (id = 1), epoch TEXT NOT NULL)",
      );
      sql.exec("INSERT OR IGNORE INTO sync_meta (id, epoch) VALUES (1, lower(hex(randomblob(8))))");
      // Filled by the mutation endpoint (build step 7); created now so the
      // schema lands in one migration.
      sql.exec(`
        CREATE TABLE IF NOT EXISTS field_clock (
          kind TEXT NOT NULL, sid TEXT NOT NULL, field TEXT NOT NULL, at_ms INTEGER NOT NULL,
          PRIMARY KEY (kind, sid, field)
        )
      `);
      sql.exec(`
        CREATE TABLE IF NOT EXISTS applied_mutations (
          mutation_id TEXT PRIMARY KEY,
          state       TEXT NOT NULL,
          result_json TEXT,
          principal   TEXT,
          lease_until INTEGER,
          at_ms       INTEGER NOT NULL
        )
      `);

      // Epoch ms inside SQL, without unixepoch() (SQLite 3.38+).
      const NOW = "CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)";
      const SID = "lower(hex(randomblob(16)))";
      const listSid = (col: string) =>
        `(SELECT sid FROM entity_map WHERE kind = 'list' AND graph_id = ${col})`;
      // Inside a trigger, a statement's own OR REPLACE / OR IGNORE is overridden
      // by the outer statement's conflict policy (the task UPSERT aborts on
      // conflict), so these never rely on one: a log write deletes the entity's
      // row and inserts a new one (which takes the next seq), and a sid is
      // minted only where none exists.
      const sidOf = (kind: string, col: string) =>
        `(SELECT sid FROM entity_map WHERE kind = '${kind}' AND graph_id = ${col})`;
      const writeLog = (kind: string, sidExpr: string, deleted: 0 | 1, listSidExpr: string) => `
          DELETE FROM sync_log WHERE kind = '${kind}' AND sid = ${sidExpr};
          INSERT INTO sync_log (kind, sid, deleted, list_sid, at_ms)
            SELECT '${kind}', ${sidExpr}, ${deleted}, ${listSidExpr}, ${NOW}
            WHERE ${sidExpr} IS NOT NULL;`;
      const logTask = (taskCol: string, listCol: string, deleted: 0 | 1) =>
        writeLog("task", sidOf("task", taskCol), deleted, listSid(listCol));
      const logList = (col: string, deleted: 0 | 1) =>
        writeLog("list", sidOf("list", col), deleted, sidOf("list", col));
      const mint = (kind: string, col: string) => `
          INSERT INTO entity_map (kind, sid, graph_id, created_ms)
            SELECT '${kind}', ${SID}, ${col}, ${NOW}
            WHERE NOT EXISTS (SELECT 1 FROM entity_map WHERE kind = '${kind}' AND graph_id = ${col});`;
      // The synced columns of each table, frozen as of this migration. A marker
      // column (checklist_synced_at) is deliberately absent, so writing it logs
      // nothing.
      const changed = (cols: string[]) => cols.map((c) => `old.${c} IS NOT new.${c}`).join(" OR ");
      const TASK_SYNCED = [
        "task_id", "list_id", "status", "title", "body_plain", "created_at", "due_at",
        "completed_at", "modified_at", "start_at", "reminder_at", "is_reminder_on",
        "importance", "has_checklist", "has_attachments", "categories_json",
        "recurrence_json", "committed_day", "committed_order", "order_datetime", "postponed_day",
      ];
      const LIST_SYNCED = ["display_name", "wellknown", "is_owner", "is_shared"];
      const STEP_SYNCED = ["task_id", "display_name", "is_checked", "created_at", "checked_at"];

      // One trigger per event, minting the sid and logging in order (SQLite
      // doesn't order separate triggers on the same event).
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS lists_sync_ai AFTER INSERT ON lists BEGIN
          ${mint("list", "new.list_id")}
          ${logList("new.list_id", 0)}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS lists_sync_au AFTER UPDATE ON lists
          WHEN ${changed(LIST_SYNCED)} BEGIN
          ${logList("new.list_id", 0)}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS lists_sync_ad AFTER DELETE ON lists BEGIN
          ${logList("old.list_id", 1)}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_sync_ai AFTER INSERT ON tasks BEGIN
          ${mint("task", "new.task_id")}
          ${logTask("new.task_id", "new.list_id", 0)}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_sync_au AFTER UPDATE ON tasks
          WHEN ${changed(TASK_SYNCED)} BEGIN
          ${logTask("new.task_id", "new.list_id", 0)}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS tasks_sync_ad AFTER DELETE ON tasks BEGIN
          ${logTask("old.task_id", "old.list_id", 1)}
        END
      `);
      // A step change bumps its task's row, but only while the task exists: a
      // task delete cascades to its steps, and that must not revive the task.
      const bumpTask = (ref: "new" | "old") => {
        const live = `(SELECT m.sid FROM entity_map m JOIN tasks t ON t.task_id = m.graph_id
            WHERE m.kind = 'task' AND m.graph_id = ${ref}.task_id)`;
        return writeLog("task", live, 0, listSid(`(SELECT list_id FROM tasks WHERE task_id = ${ref}.task_id)`));
      };
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS steps_sync_ai AFTER INSERT ON checklist_items BEGIN
          ${mint("step", "new.item_id")}
          ${bumpTask("new")}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS steps_sync_au AFTER UPDATE ON checklist_items
          WHEN ${changed(STEP_SYNCED)} BEGIN
          ${bumpTask("new")}
        END
      `);
      sql.exec(`
        CREATE TRIGGER IF NOT EXISTS steps_sync_ad AFTER DELETE ON checklist_items BEGIN
          ${bumpTask("old")}
        END
      `);

      // Existing rows (a deployment upgrading in place): give every list, task
      // and step a sid and log every list and task once, lists first.
      sql.exec(`INSERT OR IGNORE INTO entity_map (kind, sid, graph_id, created_ms)
        SELECT 'list', ${SID}, list_id, ${NOW} FROM lists`);
      sql.exec(`INSERT OR IGNORE INTO entity_map (kind, sid, graph_id, created_ms)
        SELECT 'task', ${SID}, task_id, ${NOW} FROM tasks`);
      sql.exec(`INSERT OR IGNORE INTO entity_map (kind, sid, graph_id, created_ms)
        SELECT 'step', ${SID}, item_id, ${NOW} FROM checklist_items`);
      sql.exec(`INSERT OR IGNORE INTO sync_log (kind, sid, deleted, list_sid, at_ms)
        SELECT 'list', m.sid, 0, m.sid, ${NOW} FROM lists l
        JOIN entity_map m ON m.kind = 'list' AND m.graph_id = l.list_id`);
      sql.exec(`INSERT OR IGNORE INTO sync_log (kind, sid, deleted, list_sid, at_ms)
        SELECT 'task', m.sid, 0, ${listSid("t.list_id")}, ${NOW} FROM tasks t
        JOIN entity_map m ON m.kind = 'task' AND m.graph_id = t.task_id`);
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Read the stored schema version, creating + seeding the schema_meta table on
// first use. PRAGMA user_version is unavailable here (see file header).
function currentVersion(sql: SqlDb): number {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO schema_meta (id, version) VALUES (1, 0)");
  return sql
    .exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1")
    .one().version;
}

// Returns the stored version before this call and the versions applied, so
// the caller can react (v4 on an existing database cleared sync state and
// needs the next sync cycle started).
export function applyMigrations(sql: SqlDb): { from: number; applied: number[] } {
  const cur = currentVersion(sql);
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (cur >= m.version) continue;
    m.apply(sql);
    sql.exec("UPDATE schema_meta SET version = ? WHERE id = 1", m.version);
    applied.push(m.version);
  }
  return { from: cur, applied };
}
