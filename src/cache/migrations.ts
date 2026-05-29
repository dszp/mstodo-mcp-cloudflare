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

interface Migration {
  version: number;
  apply: (sql: SqlStorage) => void;
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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

// Read the stored schema version, creating + seeding the schema_meta table on
// first use. PRAGMA user_version is unavailable here (see file header).
function currentVersion(sql: SqlStorage): number {
  sql.exec(
    "CREATE TABLE IF NOT EXISTS schema_meta (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL)",
  );
  sql.exec("INSERT OR IGNORE INTO schema_meta (id, version) VALUES (1, 0)");
  return sql
    .exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1")
    .one().version;
}

export function applyMigrations(sql: SqlStorage): void {
  const cur = currentVersion(sql);
  for (const m of MIGRATIONS) {
    if (cur >= m.version) continue;
    m.apply(sql);
    sql.exec("UPDATE schema_meta SET version = ? WHERE id = 1", m.version);
  }
}
