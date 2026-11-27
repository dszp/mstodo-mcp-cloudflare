// The sync API's code against its contract, docs/SYNC-API.md, which the app
// builds against. A field, op or capability the server has but the doc doesn't
// name (or the reverse) fails here, so the two can't drift apart unnoticed.
// When this fails, change the doc or the code in the same commit.
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { IndexCore } from "@potem/core/index/index-core";
import { openDatabase, sqlDb, transactor } from "../src/hosts/node/sqlite-db";
import { stateStore } from "../src/hosts/node/state-store";
import { OPS, UPDATABLE } from "@potem/core/sync/mutations";
import type { FeedChange } from "@potem/core/index/change-feed";

const DOC = readFileSync(new URL("../../../docs/SYNC-API.md", import.meta.url).pathname, "utf8");

// The body of the first ```json block after a heading.
function jsonAfter(heading: string): unknown {
  const at = DOC.indexOf(heading);
  if (at < 0) throw new Error(`heading not found: ${heading}`);
  const start = DOC.indexOf("```json", at) + "```json".length;
  return JSON.parse(DOC.slice(start, DOC.indexOf("```", start)));
}

// Every key path in a value, objects descended and arrays read through their
// first element: { a: { b: 1 }, c: [{ d: 1 }] } → a, a.b, c, c[].d.
// Values that are free-form by contract aren't descended: a Graph recurrence,
// and field_clock, whose keys are whichever fields have a clock.
const OPAQUE = new Set(["recurrence", "field_clock"]);
function keyPaths(v: unknown, prefix = ""): string[] {
  if (Array.isArray(v)) return v.length ? keyPaths(v[0], `${prefix}[]`) : [];
  if (!v || typeof v !== "object") return [];
  return Object.entries(v).flatMap(([k, child]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return OPAQUE.has(k) ? [path] : [path, ...keyPaths(child, path)];
  });
}

// A mirror holding one of everything the feed can carry, so every optional
// branch of the payload is present.
function populatedFeed(): FeedChange[] {
  const db = openDatabase(":memory:");
  const sql = sqlDb(db);
  const state = stateStore(db);
  const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
  c.bootstrap();
  c.upsertList({ id: "L1", displayName: "Groceries", wellknownListName: "none", isOwner: true, isShared: false } as never);
  sql.exec("INSERT INTO list_groups (group_id, name, order_datetime) VALUES ('G1', 'Home', '2026-11-20T10:00:00Z')");
  sql.exec("UPDATE lists SET group_id = 'G1', order_datetime = '2026-11-20T10:00:00Z', theme_color = 'blue', theme_background = 'beach' WHERE list_id = 'L1'");
  c.upsertTask(
    {
      id: "T1", title: "milk", status: "notStarted", importance: "normal",
      lastModifiedDateTime: "2026-11-24T10:00:00Z", createdDateTime: "2026-11-20T10:00:00Z",
      body: { contentType: "text", content: "2%" }, categories: ["Red"],
      dueDateTime: { dateTime: "2026-11-25T00:00:00.0000000", timeZone: "UTC" },
      isReminderOn: true, reminderDateTime: { dateTime: "2026-11-25T14:00:00.0000000", timeZone: "UTC" },
    } as never,
    "L1",
  );
  c.replaceChecklistItems("T1", "L1", [{ id: "S1", displayName: "step", isChecked: false, createdDateTime: "2026-11-20T10:00:00Z" }] as never);
  c.replaceLinkedResources("T1", "L1", [{ id: "K1", webUrl: "https://example.com", displayName: "x", applicationName: "app" }] as never);
  c.replaceAttachments("T1", "L1", [
    { id: "A1", name: "a.pdf", size: 1, contentType: "application/pdf", "@odata.type": "#microsoft.graph.taskFileAttachment" },
  ] as never);
  const r = c.syncChanges({ limit: 1000 });
  if (!r.ok) throw new Error(r.error);
  return r.page.changes;
}

describe("change feed matches section 4.2", () => {
  const example = jsonAfter("### 4.2 Response") as { changes: Array<Record<string, unknown>> };
  const feed = populatedFeed();

  for (const kind of ["list", "list_group", "task"]) {
    it(`${kind}: the server sends exactly the fields the doc shows`, () => {
      const documented = example.changes.find((c) => c.kind === kind && c.deleted === false);
      const sent = feed.find((c) => c.kind === kind && !c.deleted);
      expect(documented, `no live ${kind} in the 4.2 example`).toBeDefined();
      expect(sent, `no live ${kind} in the feed`).toBeDefined();
      expect(keyPaths(sent).sort()).toEqual(keyPaths(documented).sort());
    });
  }

  it("a deletion record carries only kind, id, seq and deleted", () => {
    const documented = example.changes.find((c) => c.deleted === true)!;
    expect(Object.keys(documented).sort()).toEqual(["deleted", "id", "kind", "seq"]);
  });

  it("every kind the feed sends is documented somewhere", () => {
    for (const kind of new Set(feed.map((c) => c.kind))) {
      expect(DOC, `kind ${kind}`).toContain(`"kind": "${kind}"`);
    }
  });
});

describe("mutations match section 5.2", () => {
  const section = DOC.slice(DOC.indexOf("### 5.2 Operations"), DOC.indexOf("### 5.3 Response"));
  const row = (op: string) => section.split("\n").find((l) => l.startsWith(`| \`${op}\` |`));

  for (const op of OPS) {
    it(`${op} has a row in the operations table`, () => {
      expect(row(op)).toBeDefined();
    });
  }

  for (const [op, fields] of Object.entries(UPDATABLE)) {
    it(`${op}: every updatable field is named in its row`, () => {
      const cells = row(op)?.split("|")[2] ?? "";
      for (const f of fields) expect(cells, `${op} field ${f}`).toContain(`\`${f}\``);
    });
  }

  it("the table names no op the server doesn't accept", () => {
    const documented = section
      .split("\n")
      .map((l) => /^\| `([a-z_]+\.[a-z_]+)` \|/.exec(l)?.[1])
      .filter((x): x is string => !!x);
    expect(documented.filter((op) => !(OPS as readonly string[]).includes(op))).toEqual([]);
  });
});

describe("capabilities match section 14.1", () => {
  it("/sync/info's capabilities have the keys the doc shows", async () => {
    const db = openDatabase(":memory:");
    const sql = sqlDb(db);
    const state = stateStore(db);
    const c = new IndexCore({ sql, transact: transactor(db), state, alarms: state, env: { TIMEZONE: "UTC" } as never });
    c.bootstrap();
    const info = await c.syncInfo();
    const documented = jsonAfter("### 14.1") as { capabilities: Record<string, unknown> };
    expect(Object.keys(info.capabilities).sort()).toEqual(Object.keys(documented.capabilities).sort());
  });
});
