// docs/SYNC-API.md section 18.2: immutable task IDs.
import { describe, it, expect, vi, afterEach } from "vitest";
import { openDatabase, sqlDb } from "../src/hosts/node/sqlite-db";
import { SCHEMA_DDL } from "@potem/core/index/sql";
import { applyMigrations } from "@potem/core/index/migrations";
import { GraphClient, looksImmutable } from "@potem/core/graph/client";

const tokens = { getAccessToken: async () => "tok", forceRefresh: async () => "tok2" };

afterEach(() => vi.unstubAllGlobals());

describe("GraphClient", () => {
  it("asks Graph for immutable IDs on every request", async () => {
    const seen: Array<string | null> = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("prefer"));
      return new Response(JSON.stringify({ value: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }));
    const g = new GraphClient(tokens as never);
    await g.getJson("https://graph.microsoft.com/v1.0/me/todo/lists", (await import("zod")).z.any());
    expect(seen).toEqual(['IdType="ImmutableId"']);
  });

  it("translates default REST IDs in one call and skips duplicates", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify({ value: [{ sourceId: "AAMk1", targetId: "AAkAL1" }] }), { status: 200 });
    }));
    const m = await new GraphClient(tokens as never).translateToImmutable(["AAMk1", "AAMk1", ""]);
    expect(m.get("AAMk1")).toBe("AAkAL1");
    expect(bodies).toEqual([{ inputIds: ["AAMk1"], sourceIdType: "restId", targetIdType: "restImmutableEntryId" }]);
  });

  it("tells the two ID forms apart", () => {
    expect(looksImmutable("AAkALgAAAAAA")).toBe(true);
    expect(looksImmutable("AAMkADY3ODQ5")).toBe(false);
  });
});

describe("migration v4", () => {
  it("drops task rows and task delta state but keeps lists", () => {
    const sql = sqlDb(openDatabase(":memory:"));
    sql.exec(SCHEMA_DDL);
    // Migrate fully, then wind the stored version back to 3 and seed rows the
    // way an existing deployment holds them, so the next run applies only v4.
    applyMigrations(sql);
    sql.exec("UPDATE schema_meta SET version = 3");
    sql.exec("INSERT INTO lists (list_id, display_name) VALUES ('L1', 'x')");
    sql.exec("INSERT INTO tasks (task_id, list_id, status, title) VALUES ('AAMk1', 'L1', 'notStarted', 't')");
    sql.exec("INSERT INTO checklist_items (item_id, task_id, list_id) VALUES ('s', 'AAMk1', 'L1')");
    sql.exec("INSERT INTO sync_state (resource, delta_link) VALUES ('lists', 'x'), ('tasks:L1', 'y'), ('myday:L1', NULL)");
    applyMigrations(sql);
    expect(sql.exec("SELECT count(*) n FROM tasks").one()).toEqual({ n: 0 });
    expect(sql.exec("SELECT count(*) n FROM checklist_items").one()).toEqual({ n: 0 });
    expect(sql.exec("SELECT resource FROM sync_state").toArray()).toEqual([{ resource: "lists" }]);
    expect(sql.exec("SELECT list_id FROM lists").toArray()).toEqual([{ list_id: "L1" }]);
  });
});
