// Build step 4a (docs/SYNC-API.md section 1): the task body as Graph stores it.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "@potem/core/index/index-core";
import { SCHEMA_DDL } from "@potem/core/index/sql";
import { applyMigrations } from "@potem/core/index/migrations";

const task = (body: { content: string; contentType: string }, m: string) =>
  ({ id: "T1", title: "t", status: "notStarted", lastModifiedDateTime: m, body }) as never;

function core(db = openDatabase(":memory:")) {
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return { c, sql, state };
}

describe("task body", () => {
  it("stores the body as written alongside the stripped search text", () => {
    const { c, sql } = core();
    c.upsertTask(task({ content: "<p>Call <b>Acme</b></p>", contentType: "html" }, "2026-11-24T10:00:00Z"), "L1");
    expect(sql.exec("SELECT body_content, body_type, body_plain FROM tasks").one()).toEqual({
      body_content: "<p>Call <b>Acme</b></p>",
      body_type: "html",
      body_plain: "Call Acme",
    });
  });

  it("logs a change when only the body changes", () => {
    const { c, sql } = core();
    c.upsertTask(task({ content: "a", contentType: "text" }, "2026-11-24T10:00:00Z"), "L1");
    const seq = () => sql.exec<{ s: number }>("SELECT max(seq) s FROM sync_log WHERE kind = 'task'").one().s;
    const before = seq();
    sql.exec("UPDATE tasks SET body_content = 'b' WHERE task_id = 'T1'");
    expect(seq()).toBeGreaterThan(before);
  });
});

describe("migration v7 on existing data", () => {
  it("re-baselines synced lists with mark and sweep, keeps serving them, and starts the cycle", async () => {
    const db = openDatabase(":memory:");
    const sql = sqlDb(db);
    sql.exec(SCHEMA_DDL);
    applyMigrations(sql);
    sql.exec("UPDATE schema_meta SET version = 6");
    sql.exec("INSERT INTO sync_state (resource, delta_link, last_synced_at, status) VALUES ('tasks:L1', 'dl', 1, 'idle'), ('lists', 'ldl', 1, 'idle')");
    const { c, state } = core(db);
    const st = sql.exec("SELECT delta_link, status, sweep_gen IS NOT NULL swept FROM sync_state WHERE resource = 'tasks:L1'").one();
    expect(st).toEqual({ delta_link: null, status: "baseline", swept: 1 });
    expect(sql.exec("SELECT delta_link FROM sync_state WHERE resource = 'lists'").one()).toEqual({ delta_link: "ldl" });
    expect(c.isListSynced("L1")).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(await state.getAlarm()).not.toBeNull();
  });
});
