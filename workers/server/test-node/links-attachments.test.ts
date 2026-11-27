// Build step 4b (docs/SYNC-API.md section 1.1): linked resources and
// attachment metadata in the server's copy, replaced as a diff.
import { describe, it, expect } from "vitest";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { IndexCore } from "@potem/core/index/index-core";

function core() {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  c.upsertTask({ id: "T1", title: "t", status: "notStarted", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never, "L1");
  return { c, sql };
}
const taskSeq = (sql: ReturnType<typeof sqlDb>) =>
  sql.exec<{ s: number }>("SELECT max(seq) s FROM sync_log WHERE kind = 'task'").one().s;

describe("linked resources", () => {
  it("stores, updates and removes links as a diff, bumping the task only on a real change", () => {
    const { c, sql } = core();
    const link = { id: "K1", webUrl: "https://example.com/a", displayName: "A", applicationName: "app" };
    let s = taskSeq(sql);
    c.replaceLinkedResources("T1", "L1", [link as never]);
    expect(taskSeq(sql)).toBeGreaterThan(s);
    s = taskSeq(sql);
    c.replaceLinkedResources("T1", "L1", [link as never]); // unchanged
    expect(taskSeq(sql)).toBe(s);
    c.replaceLinkedResources("T1", "L1", [{ ...link, displayName: "B" } as never]);
    expect(sql.exec("SELECT display_name FROM linked_resources").one()).toEqual({ display_name: "B" });
    c.replaceLinkedResources("T1", "L1", []);
    expect(sql.exec("SELECT count(*) n FROM linked_resources").one()).toEqual({ n: 0 });
    expect(sql.exec("SELECT count(*) n FROM entity_map WHERE kind = 'link'").one()).toEqual({ n: 1 });
  });
});

describe("attachments", () => {
  it("keeps metadata only and records the kind", () => {
    const { c, sql } = core();
    c.replaceAttachments("T1", "L1", [
      { "@odata.type": "#microsoft.graph.taskFileAttachment", id: "A1", name: "a.pdf", size: 10, contentType: "application/pdf", lastModifiedDateTime: "2026-11-24T10:00:00Z" } as never,
    ]);
    expect(sql.exec("SELECT name, size, content_type, kind FROM attachments").one()).toEqual({
      name: "a.pdf", size: 10, content_type: "application/pdf", kind: "file",
    });
  });

  it("is removed with its task", () => {
    const { c, sql } = core();
    c.replaceAttachments("T1", "L1", [{ "@odata.type": "#microsoft.graph.taskFileAttachment", id: "A1" } as never]);
    c.replaceLinkedResources("T1", "L1", [{ id: "K1" } as never]);
    c.deleteTask("T1");
    expect(sql.exec("SELECT (SELECT count(*) FROM attachments) + (SELECT count(*) FROM linked_resources) n").one()).toEqual({ n: 0 });
  });
});

describe("checklist replace", () => {
  it("leaves an unchanged step alone, so the task isn't re-logged", () => {
    const { c, sql } = core();
    const step = { id: "S1", displayName: "x", isChecked: false };
    c.replaceChecklistItems("T1", "L1", [step as never]);
    const s = taskSeq(sql);
    c.replaceChecklistItems("T1", "L1", [step as never]);
    expect(taskSeq(sql)).toBe(s);
  });
});
