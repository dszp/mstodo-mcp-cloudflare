// Build step 2 foundations (docs/SYNC-API.md section 18.5): the Transact port,
// the atomic IndexCore.moveTask, the delta-overwrite guard, and deleteList's
// cascade to checklist rows. Runs IndexCore in process over node:sqlite.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";

function core() {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return { c, sql, transact: transactor(db) };
}

const task = (id: string, title: string, modified: string) =>
  ({ id, title, status: "notStarted", lastModifiedDateTime: modified }) as never;
const row = (sql: ReturnType<typeof sqlDb>, id: string) =>
  sql.exec("SELECT * FROM tasks WHERE task_id = ?", id).toArray()[0] as Record<string, unknown> | undefined;

describe("Transact (node)", () => {
  it("commits on success and rolls back on throw", () => {
    const { sql, transact } = core();
    sql.exec("CREATE TABLE t (x INTEGER)");
    transact(() => sql.exec("INSERT INTO t VALUES (1)"));
    expect(() =>
      transact(() => {
        sql.exec("INSERT INTO t VALUES (2)");
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(sql.exec<{ x: number }>("SELECT x FROM t").toArray()).toEqual([{ x: 1 }]);
  });
});

describe("IndexCore.moveTask", () => {
  it("re-keys a task and its steps, keeping My Day fields", () => {
    const { c, sql } = core();
    c.upsertTask(task("old", "A", "2026-11-23T10:00:00Z"), "L1");
    c.updateMyDayFields("old", { committed_day: "2026-11-23", committed_order: "x" });
    c.upsertChecklistItem("old", "L1", { id: "s1", displayName: "step", isChecked: false } as never);

    c.moveTask("old", "L2", "new");

    expect(row(sql, "old")).toBeUndefined();
    expect(row(sql, "new")).toMatchObject({ list_id: "L2", title: "A", committed_day: "2026-11-23" });
    expect(sql.exec("SELECT task_id, list_id FROM checklist_items").toArray()).toEqual([
      { task_id: "new", list_id: "L2" },
    ]);
  });

  it("merges into a destination row that delta already inserted", () => {
    const { c, sql } = core();
    c.upsertTask(task("old", "A", "2026-11-23T10:00:00Z"), "L1");
    c.updateMyDayFields("old", { committed_day: "2026-11-23" });
    c.upsertTask(task("new", "A (from delta)", "2026-11-23T10:05:00Z"), "L2");

    c.moveTask("old", "L2", "new");

    expect(row(sql, "old")).toBeUndefined();
    expect(row(sql, "new")).toMatchObject({ title: "A (from delta)", committed_day: "2026-11-23" });
  });

  it("only changes the list when the ID is stable", () => {
    const { c, sql } = core();
    c.upsertTask(task("same", "A", "2026-11-23T10:00:00Z"), "L1");
    c.moveTask("same", "L2");
    expect(row(sql, "same")).toMatchObject({ list_id: "L2" });
  });
});

describe("delta-overwrite guard", () => {
  it("keeps a newer row when an older copy arrives", () => {
    const { c, sql } = core();
    c.upsertTask(task("t", "new title", "2026-11-23T10:05:00Z"), "L1");
    c.upsertTask(task("t", "stale title", "2026-11-23T10:00:00Z"), "L1");
    expect(row(sql, "t")).toMatchObject({ title: "new title" });
    c.upsertTask(task("t", "newest", "2026-11-23T10:06:00Z"), "L1");
    expect(row(sql, "t")).toMatchObject({ title: "newest" });
  });
});

describe("deleteList", () => {
  it("removes the list's checklist rows too", () => {
    const { c, sql } = core();
    c.upsertList({ id: "L1", displayName: "x" } as never);
    c.upsertTask(task("t", "A", "2026-11-23T10:00:00Z"), "L1");
    c.upsertChecklistItem("t", "L1", { id: "s1", displayName: "step" } as never);
    c.deleteList("L1");
    expect(sql.exec("SELECT count(*) n FROM checklist_items").one()).toEqual({ n: 0 });
  });
});
