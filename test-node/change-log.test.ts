// Migration v5 change log (docs/SYNC-API.md section 3) on node:sqlite.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";
import { SCHEMA_DDL } from "../src/core/index/sql";
import { applyMigrations } from "../src/core/index/migrations";
import { runChangeLogChecks } from "../test/_change-log-checks";

function core() {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return { c, sql, state };
}

describe("change log (node)", () => {
  const r = (() => {
    const { c, sql } = core();
    return runChangeLogChecks(c, sql);
  })();
  for (const [name, ok] of Object.entries(r)) {
    it(name, () => expect(ok).toBe(true));
  }
});

describe("migration v5 on existing data", () => {
  it("gives existing rows stable IDs and logs lists and tasks", () => {
    const sql = sqlDb(openDatabase(":memory:"));
    sql.exec(SCHEMA_DDL);
    applyMigrations(sql);
    sql.exec("DROP TABLE sync_log; DROP TABLE entity_map; DROP TABLE sync_meta");
    for (const tr of ["lists", "tasks", "steps"])
      for (const e of ["ai", "au", "ad"]) sql.exec(`DROP TRIGGER ${tr}_sync_${e}`);
    sql.exec("UPDATE schema_meta SET version = 4");
    sql.exec("INSERT INTO lists (list_id, display_name) VALUES ('L1', 'x')");
    sql.exec("INSERT INTO tasks (task_id, list_id, status, title) VALUES ('T1', 'L1', 'notStarted', 't')");
    sql.exec("INSERT INTO checklist_items (item_id, task_id, list_id) VALUES ('S1', 'T1', 'L1')");

    expect(applyMigrations(sql).applied).toEqual([5]);
    const kinds = sql.exec<{ kind: string; n: number }>("SELECT kind, count(*) n FROM entity_map GROUP BY kind ORDER BY kind").toArray();
    expect(kinds).toEqual([{ kind: "list", n: 1 }, { kind: "step", n: 1 }, { kind: "task", n: 1 }]);
    const logged = sql.exec<{ kind: string }>("SELECT kind FROM sync_log ORDER BY seq").toArray();
    expect(logged).toEqual([{ kind: "list" }, { kind: "task" }]);
    expect(sql.exec<{ e: string }>("SELECT epoch e FROM sync_meta").one().e).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("bootstrap", () => {
  it("starts the next sync cycle when migration v4 runs on an existing database", async () => {
    const db = openDatabase(":memory:");
    const sql = sqlDb(db);
    sql.exec(SCHEMA_DDL);
    applyMigrations(sql);
    sql.exec("UPDATE schema_meta SET version = 3");
    const state = stateStore(db);
    new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never }).bootstrap();
    await new Promise((r) => setTimeout(r, 10));
    expect(await state.getAlarm()).not.toBeNull();
  });

  it("leaves a fresh database's alarm alone", async () => {
    const { state } = core();
    await new Promise((r) => setTimeout(r, 10));
    expect(await state.getAlarm()).toBeNull();
  });
});

describe("resetIdentity", () => {
  it("clears the change log and stable IDs and replaces the epoch", async () => {
    const { c, sql } = core();
    c.upsertList({ id: "L1", displayName: "x" } as never);
    const before = sql.exec<{ e: string }>("SELECT epoch e FROM sync_meta").one().e;
    await c.resetIdentity();
    expect(sql.exec("SELECT count(*) n FROM sync_log").one()).toEqual({ n: 0 });
    expect(sql.exec("SELECT count(*) n FROM entity_map").one()).toEqual({ n: 0 });
    expect(sql.exec<{ e: string }>("SELECT epoch e FROM sync_meta").one().e).not.toBe(before);
  });
});
