import { describe, it, expect, vi, afterEach } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TodoIndex } from "../src/cache/index-do";
import { LATEST_SCHEMA_VERSION } from "../src/cache/migrations";
import { SCOPES, TOKENS_KEY } from "../src/auth/microsoft";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const stub = () => env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName("owner"));
const named = (name: string) => env.TODO_INDEX_DO.getByName(name);

describe("schema migration v3 — checklist-item cache", () => {
  it("bumps LATEST_SCHEMA_VERSION to 3", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(3);
  });

  it("creates the checklist_items table with the expected columns", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const cols = ctx.storage.sql
        .exec("PRAGMA table_info(checklist_items)")
        .toArray()
        .map((r) => r.name as string);
      expect(cols).toEqual(
        expect.arrayContaining([
          "item_id",
          "task_id",
          "list_id",
          "display_name",
          "is_checked",
          "created_at",
          "checked_at",
        ]),
      );
    });
  });

  it("creates the checklist_items indexes", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const names = ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='index'")
        .toArray()
        .map((r) => r.name as string);
      expect(names).toContain("checklist_items_task");
      expect(names).toContain("checklist_items_open");
    });
  });

  it("adds the checklist_synced_at marker column to tasks", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const cols = ctx.storage.sql
        .exec("PRAGMA table_info(tasks)")
        .toArray()
        .map((r) => r.name as string);
      expect(cols).toContain("checklist_synced_at");
    });
  });

  it("creates the checklist_fts external-content table", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const names = ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='table'")
        .toArray()
        .map((r) => r.name as string);
      expect(names).toContain("checklist_fts");
    });
  });

  it("checklist_fts mirrors display_name on insert and ignores is_checked toggles", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec("DELETE FROM checklist_items");
      sql.exec(
        "INSERT INTO checklist_items (item_id, task_id, list_id, display_name, is_checked) VALUES ('i1', 't1', 'L', 'waiting on acme', 0)",
      );
      const hit = sql
        .exec<{ c: number }>(
          "SELECT COUNT(*) AS c FROM checklist_fts WHERE checklist_fts MATCH 'acme'",
        )
        .one().c;
      expect(hit).toBe(1);

      // Toggling is_checked must NOT churn the FTS index (AFTER UPDATE OF display_name).
      const before = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM checklist_fts").one().c;
      sql.exec("UPDATE checklist_items SET is_checked = 1 WHERE item_id = 'i1'");
      const after = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM checklist_fts").one().c;
      expect(after).toBe(before);
    });
  });

  it("is idempotent across boots (ALTER would throw if re-run)", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const { version } = ctx.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1")
        .one();
      expect(version).toBe(LATEST_SCHEMA_VERSION);
      expect(() =>
        ctx.storage.sql.exec("ALTER TABLE tasks ADD COLUMN checklist_synced_at INTEGER"),
      ).toThrow(/duplicate column name/i);
    });
  });
});

describe("checklist store methods", () => {
  const seedTask = async (taskId: string, listId = "L") => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO tasks (task_id, list_id, status, title) VALUES (?, ?, 'notStarted', 't')",
        taskId,
        listId,
      );
    });
  };

  const itemsFor = (taskId: string) =>
    runInDurableObject(stub(), async (_: TodoIndex, ctx) =>
      ctx.storage.sql
        .exec<{ item_id: string; display_name: string | null; is_checked: number }>(
          "SELECT item_id, display_name, is_checked FROM checklist_items WHERE task_id = ? ORDER BY item_id",
          taskId,
        )
        .toArray(),
    );

  const taskMeta = (taskId: string) =>
    runInDurableObject(stub(), async (_: TodoIndex, ctx) =>
      ctx.storage.sql
        .exec<{ has_checklist: number | null; checklist_synced_at: number | null }>(
          "SELECT has_checklist, checklist_synced_at FROM tasks WHERE task_id = ?",
          taskId,
        )
        .one(),
    );

  it("replaceChecklistItems inserts items, stamps synced_at, sets has_checklist=1", async () => {
    await seedTask("t1");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t1", "L", [
        { id: "i1", displayName: "waiting on acme", isChecked: false, createdDateTime: "2026-05-01T00:00:00Z" },
        { id: "i2", displayName: "ping bob", isChecked: true, createdDateTime: "2026-05-02T00:00:00Z", checkedDateTime: "2026-05-03T00:00:00Z" },
      ]);
    });
    const items = await itemsFor("t1");
    expect(items.map((i) => i.item_id)).toEqual(["i1", "i2"]);
    expect(items.find((i) => i.item_id === "i2")?.is_checked).toBe(1);
    const meta = await taskMeta("t1");
    expect(meta.has_checklist).toBe(1);
    expect(meta.checklist_synced_at).not.toBeNull();
  });

  it("replaceChecklistItems removes items no longer present", async () => {
    await seedTask("t2");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t2", "L", [
        { id: "a", displayName: "one", isChecked: false },
        { id: "b", displayName: "two", isChecked: false },
      ]);
      await instance.replaceChecklistItems("t2", "L", [{ id: "b", displayName: "two", isChecked: false }]);
    });
    expect((await itemsFor("t2")).map((i) => i.item_id)).toEqual(["b"]);
  });

  it("replaceChecklistItems with an empty array clears items and sets has_checklist=0", async () => {
    await seedTask("t3");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t3", "L", [{ id: "x", displayName: "x", isChecked: false }]);
      await instance.replaceChecklistItems("t3", "L", []);
    });
    expect(await itemsFor("t3")).toEqual([]);
    const meta = await taskMeta("t3");
    expect(meta.has_checklist).toBe(0);
    expect(meta.checklist_synced_at).not.toBeNull();
  });

  it("markChecklistDirty nulls checklist_synced_at", async () => {
    await seedTask("t4");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t4", "L", [{ id: "x", displayName: "x", isChecked: false }]);
      await instance.markChecklistDirty("t4");
    });
    expect((await taskMeta("t4")).checklist_synced_at).toBeNull();
  });

  it("clearChecklistItems removes a task's items", async () => {
    await seedTask("t5");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t5", "L", [{ id: "t5x", displayName: "x", isChecked: false }]);
      await instance.clearChecklistItems("t5");
    });
    expect(await itemsFor("t5")).toEqual([]);
  });

  it("deleteTask cascades to checklist_items", async () => {
    await seedTask("t6");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t6", "L", [{ id: "t6x", displayName: "x", isChecked: false }]);
      instance.deleteTask("t6");
    });
    expect(await itemsFor("t6")).toEqual([]);
  });

  it("upsertChecklistItem adds then updates a single item (write-through)", async () => {
    await seedTask("t7");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.upsertChecklistItem("t7", "L", { id: "t7i1", displayName: "first", isChecked: false });
      await instance.upsertChecklistItem("t7", "L", { id: "t7i1", displayName: "first", isChecked: true, checkedDateTime: "2026-05-03T00:00:00Z" });
    });
    const items = await itemsFor("t7");
    expect(items).toHaveLength(1);
    expect(items[0].is_checked).toBe(1);
    // Write-through sets has_checklist but leaves the marker untouched (table may be incomplete).
    expect((await taskMeta("t7")).has_checklist).toBe(1);
  });

  it("deleteChecklistItem removes a single item (write-through)", async () => {
    await seedTask("t8");
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.replaceChecklistItems("t8", "L", [
        { id: "t8i1", displayName: "one", isChecked: false },
        { id: "t8i2", displayName: "two", isChecked: false },
      ]);
      await instance.deleteChecklistItem("t8", "t8i1");
    });
    expect((await itemsFor("t8")).map((i) => i.item_id)).toEqual(["t8i2"]);
  });
});

describe("selectDueChecklistTasks", () => {
  it("picks NULL-marker OPEN tasks, excludes skipped lists, newest-changed first, capped", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      const ins = (
        id: string,
        listId: string,
        status: string,
        modified: number | null,
        synced: number | null,
      ) =>
        ctx.storage.sql.exec(
          "INSERT INTO tasks (task_id, list_id, status, title, modified_at, checklist_synced_at) VALUES (?, ?, ?, ?, ?, ?)",
          id,
          listId,
          status,
          id,
          modified,
          synced,
        );
      ins("due-new", "L", "notStarted", 3000, null); // due, newest
      ins("due-old", "L", "inProgress", 1000, null); // due, older
      ins("already", "L", "notStarted", 5000, 9999); // marker set → not due
      ins("done", "L", "completed", 4000, null); // completed → excluded
      ins("skipped", "SKIP", "notStarted", 6000, null); // skipped list → excluded

      const due = await instance.selectDueChecklistTasks(10, ["SKIP"]);
      expect(due.map((d) => d.task_id)).toEqual(["due-new", "due-old"]);

      const capped = await instance.selectDueChecklistTasks(1, ["SKIP"]);
      expect(capped.map((d) => d.task_id)).toEqual(["due-new"]);
    });
  });
});

describe("query has_open_checklist_item filter", () => {
  const seed = async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      ctx.storage.sql.exec("DELETE FROM checklist_items");
      const t = (id: string) =>
        ctx.storage.sql.exec(
          "INSERT INTO tasks (task_id, list_id, status, title, modified_at) VALUES (?, 'L', 'notStarted', ?, 1000)",
          id,
          id,
        );
      t("open"); // has an unchecked item
      t("done"); // has only a checked item
      t("none"); // no items at all
      await instance.replaceChecklistItems("open", "L", [
        { id: "q-open-1", displayName: "waiting", isChecked: false },
      ]);
      await instance.replaceChecklistItems("done", "L", [
        { id: "q-done-1", displayName: "finished", isChecked: true },
      ]);
    });
  };

  it("true returns only tasks with at least one OPEN checklist item", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.query({ has_open_checklist_item: true });
      expect(rows.map((r) => r.task_id).sort()).toEqual(["open"]);
    });
  });

  it("false returns only tasks with NO open checklist item", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.query({ has_open_checklist_item: false });
      expect(rows.map((r) => r.task_id).sort()).toEqual(["done", "none"]);
    });
  });
});

describe("searchChecklistItems", () => {
  const seed = async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      ctx.storage.sql.exec("DELETE FROM checklist_items");
      const t = (id: string, listId = "L") =>
        ctx.storage.sql.exec(
          "INSERT INTO tasks (task_id, list_id, status, title, modified_at) VALUES (?, ?, 'notStarted', ?, 1000)",
          id,
          listId,
          `title-${id}`,
        );
      t("ta");
      t("tb");
      t("tc", "OTHER");
      await instance.replaceChecklistItems("ta", "L", [
        { id: "s-a1", displayName: "waiting on acme reply", isChecked: false, createdDateTime: "2026-05-01T00:00:00Z" },
        { id: "s-a2", displayName: "acme already answered", isChecked: true, createdDateTime: "2026-04-01T00:00:00Z" },
      ]);
      await instance.replaceChecklistItems("tb", "L", [
        { id: "s-b1", displayName: "ping acme again", isChecked: false, createdDateTime: "2026-03-01T00:00:00Z" },
      ]);
      await instance.replaceChecklistItems("tc", "OTHER", [
        { id: "s-c1", displayName: "acme contract", isChecked: false, createdDateTime: "2026-02-01T00:00:00Z" },
      ]);
    });
  };

  it("FTS-matches checklist text and returns the parent task title", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.searchChecklistItems({ query: "acme" });
      // pending_only defaults true → the checked s-a2 is excluded.
      expect(rows.map((r) => r.item_id).sort()).toEqual(["s-a1", "s-b1", "s-c1"]);
      expect(rows.find((r) => r.item_id === "s-a1")?.task_title).toBe("title-ta");
    });
  });

  it("pending_only=false includes checked items", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.searchChecklistItems({ query: "acme", pending_only: false });
      expect(rows.map((r) => r.item_id).sort()).toEqual(["s-a1", "s-a2", "s-b1", "s-c1"]);
    });
  });

  it("with no query, lists pending items oldest-first (the follow-up view)", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.searchChecklistItems({});
      // open items only, ordered by created_at ASC: s-c1(Feb) < s-b1(Mar) < s-a1(May)
      expect(rows.map((r) => r.item_id)).toEqual(["s-c1", "s-b1", "s-a1"]);
    });
  });

  it("restricts to the given lists", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.searchChecklistItems({ query: "acme", lists: ["OTHER"] });
      expect(rows.map((r) => r.item_id)).toEqual(["s-c1"]);
    });
  });
});

describe("search include_checklist (tiered: title/body first, checklist-only appended)", () => {
  const seed = async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      ctx.storage.sql.exec("DELETE FROM checklist_items");
      const t = (id: string, title: string, listId = "L") =>
        ctx.storage.sql.exec(
          "INSERT INTO tasks (task_id, list_id, status, title, modified_at) VALUES (?, ?, 'notStarted', ?, 1000)",
          id,
          listId,
          title,
        );
      t("tt", "acme report"); // title match only
      t("tc", "weekly sync"); // matches via checklist text only
      t("tboth", "acme deal"); // matches both title and checklist
      t("tnone", "groceries"); // no match
      await instance.replaceChecklistItems("tc", "L", [
        { id: "se-c1", displayName: "call acme back", isChecked: false },
      ]);
      await instance.replaceChecklistItems("tboth", "L", [
        { id: "se-b1", displayName: "acme follow-up", isChecked: false },
      ]);
    });
  };

  it("false: title/body only (a checklist-only match is NOT returned)", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.search({ query: "acme", include_checklist: false });
      expect(rows.map((r) => r.task_id).sort()).toEqual(["tboth", "tt"]);
    });
  });

  it("true: appends the checklist-only match after the title/body matches, deduped", async () => {
    await seed();
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      const { rows } = await instance.search({ query: "acme", include_checklist: true });
      const ids = rows.map((r) => r.task_id);
      expect(ids).toHaveLength(3); // tboth counted once despite matching both tiers
      expect(ids.slice(0, 2).sort()).toEqual(["tboth", "tt"]); // tier 0 first
      expect(ids[2]).toBe("tc"); // checklist-only match appended last
    });
  });

  it("true: list filter also constrains the checklist matches", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      ctx.storage.sql.exec("DELETE FROM checklist_items");
      ctx.storage.sql.exec(
        "INSERT INTO tasks (task_id, list_id, status, title, modified_at) VALUES ('only', 'OTHER', 'notStarted', 'weekly', 1000)",
      );
      await instance.replaceChecklistItems("only", "OTHER", [
        { id: "se-o1", displayName: "acme thing", isChecked: false },
      ]);
      const inOther = await instance.search({ query: "acme", include_checklist: true, lists: ["OTHER"] });
      expect(inOther.rows.map((r) => r.task_id)).toEqual(["only"]);
      const inL = await instance.search({ query: "acme", include_checklist: true, lists: ["L"] });
      expect(inL.rows).toHaveLength(0);
    });
  });
});

describe("runSyncCycle checklist backfill scan (ENABLE_CHECKLIST_CACHE on in tests)", () => {
  const LISTS_DELTA = "https://graph.microsoft.com/v1.0/me/todo/lists/delta";
  const realFetch = globalThis.fetch;
  afterEach(async () => {
    globalThis.fetch = realFetch;
    await env.TODO_CACHE.delete(TOKENS_KEY);
  });
  const signIn = () =>
    env.TODO_CACHE.put(
      TOKENS_KEY,
      JSON.stringify({
        access_token: "AT",
        refresh_token: "RT",
        expires_at: Date.now() + 3_600_000,
        scope: SCOPES,
        obtained_at: Date.now(),
      }),
    );

  it("fetches and caches a freshly-synced task's checklist within the calm cycle", async () => {
    await signIn();
    const stub = named("checklist-scan-1");
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      const m = init?.method ?? "GET";
      if (u.includes("/me/todo/lists/delta")) {
        return Response.json(
          { value: [{ id: "L1", displayName: "Work" }], "@odata.deltaLink": `${LISTS_DELTA}?$deltatoken=z` },
          { status: 200 },
        );
      }
      if (u.includes("/lists/L1/tasks/delta")) {
        return Response.json(
          {
            value: [{ id: "TK1", title: "Reply to Acme", status: "notStarted", lastModifiedDateTime: "2026-05-02T00:00:00Z" }],
            "@odata.deltaLink": "https://graph.microsoft.com/v1.0/x?$deltatoken=z",
          },
          { status: 200 },
        );
      }
      if (u.includes("/tasks/TK1/checklistItems") && m === "GET") {
        return Response.json(
          { value: [{ id: "CI1", displayName: "waiting on acme reply", isChecked: false, createdDateTime: "2026-05-02T00:00:00Z" }] },
          { status: 200 },
        );
      }
      if (u.endsWith("/subscriptions")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("substrate.office.com")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("login.microsoftonline.com"))
        return Response.json({ access_token: "EXO", expires_in: 3600 }, { status: 200 });
      return new Response(`unscripted ${m} ${u}`, { status: 404 });
    }) as unknown as typeof fetch;

    await stub.runSyncCycle();

    const items = await stub.getChecklistItems("TK1");
    expect(items.map((i) => i.item_id)).toEqual(["CI1"]);
    expect(items[0].display_name).toBe("waiting on acme reply");
  });

  it("a 410 re-baseline purges the list's cached checklist rows (no orphans)", async () => {
    await signIn();
    const stub = named("checklist-410");
    const TK_DELTA = "https://graph.microsoft.com/v1.0/me/todo/lists/L1/tasks/delta";
    const TK_DL = `${TK_DELTA}?$deltatoken=t1`;
    // Cycle 1: baseline L1 → task TKA, scan caches its checklist.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      const m = init?.method ?? "GET";
      if (u.includes("/me/todo/lists/delta"))
        return Response.json({ value: [{ id: "L1", displayName: "Work" }], "@odata.deltaLink": `${LISTS_DELTA}?$deltatoken=z` }, { status: 200 });
      if (u === TK_DELTA)
        return Response.json({ value: [{ id: "TKA", title: "Reply", status: "notStarted", lastModifiedDateTime: "2026-05-02T00:00:00Z" }], "@odata.deltaLink": TK_DL }, { status: 200 });
      if (u.includes("/tasks/TKA/checklistItems") && m === "GET")
        return Response.json({ value: [{ id: "CIA", displayName: "waiting", isChecked: false, createdDateTime: "2026-05-02T00:00:00Z" }] }, { status: 200 });
      if (u.endsWith("/subscriptions")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("substrate.office.com")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("login.microsoftonline.com")) return Response.json({ access_token: "EXO", expires_in: 3600 }, { status: 200 });
      return new Response(`unscripted ${m} ${u}`, { status: 404 });
    }) as unknown as typeof fetch;
    await stub.runSyncCycle();
    expect((await stub.getChecklistItems("TKA")).map((i) => i.item_id)).toEqual(["CIA"]);

    // Cycle 2: the stored tasks deltaLink now 410s → purge L1 (tasks + checklist).
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const u = String(input);
      const m = init?.method ?? "GET";
      if (u.includes("/me/todo/lists/delta"))
        return Response.json({ value: [], "@odata.deltaLink": `${LISTS_DELTA}?$deltatoken=z` }, { status: 200 });
      if (u === TK_DL) return Response.json({ error: { code: "syncStateNotFound" } }, { status: 410 });
      if (u.endsWith("/subscriptions")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("substrate.office.com")) return Response.json({ value: [] }, { status: 200 });
      if (u.includes("login.microsoftonline.com")) return Response.json({ access_token: "EXO", expires_in: 3600 }, { status: 200 });
      return new Response(`unscripted ${m} ${u}`, { status: 404 });
    }) as unknown as typeof fetch;
    await stub.runSyncCycle();

    expect(await stub.getChecklistItems("TKA")).toEqual([]);
  });
});
