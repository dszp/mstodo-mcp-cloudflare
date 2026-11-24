// Build step 4c (docs/SYNC-API.md sections 1.1, 1.2, 18.7a): archive lists,
// and step order stored per checklist item.
import { describe, it, expect } from "vitest";
import { isArchiveList } from "../src/core/config/sync-policy";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "../src/core/index/index-core";

const cfg = (archive: string[]) =>
  ({ patterns: [], aliases: {}, overrides: {}, no_sync: [], archive, sync_flagged_emails: true }) as never;

describe("isArchiveList", () => {
  it("treats flagged email as archive, and honors archive by ID or wellknown name", () => {
    expect(isArchiveList({ list_id: "F", wellknown: "flaggedEmails" }, cfg([]))).toBe(true);
    expect(isArchiveList({ list_id: "L1", wellknown: null }, cfg(["L1"]))).toBe(true);
    expect(isArchiveList({ list_id: "L2", wellknown: null }, cfg(["L1"]))).toBe(false);
  });
});

describe("step order", () => {
  it("is stored per step and a change bumps the task's log row", () => {
    const db = openDatabase(":memory:");
    const sql = sqlDb(db);
    const state = stateStore(db);
    const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
    c.bootstrap();
    c.upsertTask({ id: "T1", title: "t", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
    c.replaceChecklistItems("T1", "L1", [{ id: "S1", displayName: "x" } as never]);
    const seq = () => sql.exec<{ s: number }>("SELECT max(seq) s FROM sync_log WHERE kind = 'task'").one().s;
    const before = seq();
    sql.exec("UPDATE checklist_items SET order_datetime = '2026-11-24T10:00:00Z' WHERE item_id = 'S1'");
    expect(seq()).toBeGreaterThan(before);
  });
});

describe("searchChecklistItems", () => {
  it("lists every step when there is no query, no list filter and pending_only is false", () => {
    const db = openDatabase(":memory:");
    const sql = sqlDb(db);
    const state = stateStore(db);
    const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
    c.bootstrap();
    c.upsertTask({ id: "T1", title: "t", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
    c.replaceChecklistItems("T1", "L1", [{ id: "S1", displayName: "x", isChecked: true } as never]);
    expect(c.searchChecklistItems({ pending_only: false }).rows.map((r) => r.item_id)).toEqual(["S1"]);
  });
});
