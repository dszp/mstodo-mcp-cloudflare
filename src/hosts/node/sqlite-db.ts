import { DatabaseSync } from "node:sqlite";
import type { SqlDb, SqlValue } from "../../core/ports";

export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  // busy_timeout first: switching journal_mode can need a lock, and without a
  // timeout a second process opening the file fails at once with "database is
  // locked" instead of waiting (and then reaching the instance lock check).
  db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return db;
}

// node:sqlite binds Uint8Array, not ArrayBuffer.
const bind = (p: SqlValue) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p);

// Cloudflare's sql.exec runs several statements when there are no bindings
// (SCHEMA_DDL, migrations). node:sqlite's prepare() does NOT reject a
// multi-statement string: it compiles only the first statement and silently
// drops the rest (verified on Node 24: "CREATE TABLE a(x); CREATE TABLE b(y)"
// creates only `a`). So parameterless calls prepare first, to learn whether
// the statement returns rows; a row-less one is re-run whole through db.exec,
// which executes every statement. Splitting on ';' is avoided on purpose:
// trigger bodies and string literals contain semicolons.
export function sqlDb(db: DatabaseSync): SqlDb {
  return {
    exec(query: string, ...params: SqlValue[]) {
      const args = params.map(bind) as never[];
      const stmt = db.prepare(query);
      let rows: never[] = [];
      if (stmt.columns().length > 0) rows = stmt.all(...args) as never[];
      else if (params.length === 0) db.exec(query);
      else stmt.run(...args);
      return {
        toArray: () => rows,
        one: () => {
          if (rows.length !== 1) throw new Error(`Expected exactly one row, got ${rows.length}`);
          return rows[0];
        },
      };
    },
  };
}
