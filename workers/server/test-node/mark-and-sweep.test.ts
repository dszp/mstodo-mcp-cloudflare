// docs/SYNC-API.md section 3.3: resync re-baselines without emptying lists.
// Drives IndexCore's sweep through resync + the delta apply path directly.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "@potem/core/index/index-core";

const t = (id: string, m = "2026-11-24T10:00:00Z") =>
  ({ id, title: id, status: "notStarted", lastModifiedDateTime: m }) as never;

function core() {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  return { c, sql };
}

describe("resync (mark and sweep)", () => {
  it("keeps rows during the baseline and logs no deletions for rows it sees again", async () => {
    const { c, sql } = core();
    c.upsertList({ id: "L1", displayName: "x" } as never);
    c.upsertTask(t("a"), "L1");
    c.upsertTask(t("b"), "L1");
    const seqBefore = sql.exec<{ s: number }>("SELECT max(seq) s FROM sync_log").one().s;

    sql.exec("INSERT INTO sync_state (resource, delta_link, last_synced_at) VALUES ('tasks:L1', 'dl', 1)");
    expect(c.isListSynced("L1")).toBe(true);
    await c.resync("L1");
    expect(sql.exec("SELECT count(*) n FROM tasks").one()).toEqual({ n: 2 });
    // Still served from the index while the baseline runs.
    expect(c.isListSynced("L1")).toBe(true);
    // The baseline returns "a" unchanged and a write-through adds "c" meanwhile.
    c.upsertTask(t("a"), "L1");
    c.upsertTask(t("c"), "L1");
    // Nothing for "a" was logged: it didn't change.
    const aSeq = sql.exec<{ s: number }>(
      "SELECT l.seq s FROM sync_log l JOIN entity_map m ON m.sid = l.sid AND m.kind = 'task' WHERE m.graph_id = 'a'",
    ).one().s;
    expect(aSeq).toBeLessThanOrEqual(seqBefore);
    const gen = sql.exec<{ g: number }>("SELECT sweep_gen g FROM sync_state WHERE resource = 'tasks:L1'").one().g;
    expect(gen).not.toBeNull();
    expect(sql.exec("SELECT task_id FROM tasks WHERE baseline_gen = ? ORDER BY task_id", gen).toArray()).toEqual([
      { task_id: "a" },
      { task_id: "c" },
    ]);
  });

  it("a list that never finished a baseline isn't served from the index", async () => {
    const { c } = core();
    c.upsertList({ id: "L2", displayName: "y" } as never);
    await c.resync("L2");
    expect(c.isListSynced("L2")).toBe(false);
  });

  it("a full resync keeps the roster, the webhook telemetry and My Day scan state", async () => {
    const { c, sql } = core();
    c.upsertList({ id: "L1", displayName: "x" } as never);
    sql.exec("INSERT INTO sync_state (resource, last_synced_at) VALUES ('myday:L1', 5)");
    await c.resync();
    expect(sql.exec("SELECT count(*) n FROM lists").one()).toEqual({ n: 1 });
    expect(sql.exec("SELECT last_synced_at l FROM sync_state WHERE resource = 'myday:L1'").one()).toEqual({ l: 5 });
    expect(sql.exec("SELECT count(*) n FROM sync_state WHERE sweep_gen IS NOT NULL").one()).toEqual({ n: 2 });
  });
});
