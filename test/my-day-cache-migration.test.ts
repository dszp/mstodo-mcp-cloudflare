import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TodoIndex } from "../src/cache/index-do";
import { isScanDue } from "../src/cache/index-do";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}

const stub = () => env.TODO_INDEX_DO.get(env.TODO_INDEX_DO.idFromName("owner"));

describe("schema migration v1 — Substrate field columns", () => {
  it("adds committed_day, committed_order, order_datetime, postponed_day to tasks", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const cols = ctx.storage.sql
        .exec("PRAGMA table_info(tasks)")
        .toArray()
        .map((r) => r.name as string);
      expect(cols).toContain("committed_day");
      expect(cols).toContain("committed_order");
      expect(cols).toContain("order_datetime");
      expect(cols).toContain("postponed_day");
    });
  });

  it("creates the tasks_committed_day index", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const names = ctx.storage.sql
        .exec("SELECT name FROM sqlite_master WHERE type='index'")
        .toArray()
        .map((r) => r.name as string);
      expect(names).toContain("tasks_committed_day");
    });
  });

  it("stamps schema_meta version = 1 and is idempotent across boots", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const { version } = ctx.storage.sql
        .exec<{ version: number }>("SELECT version FROM schema_meta WHERE id = 1")
        .one();
      expect(version).toBe(1);
      // The ALTER would error if the migration ran twice — proof the column
      // already exists, i.e. the migration applied exactly once.
      expect(() =>
        ctx.storage.sql.exec("ALTER TABLE tasks ADD COLUMN committed_day TEXT"),
      ).toThrow(/duplicate column name/i);
    });
  });

  it("tasks_au trigger fires only on title/body_plain updates", async () => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(
        "INSERT INTO tasks (task_id, list_id, status, title) VALUES ('t1', 'L', 'notStarted', 'hello')",
      );
      const before = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM tasks_fts").one().c;
      sql.exec("UPDATE tasks SET committed_order = '2026-05-27T05:00:00Z' WHERE task_id = 't1'");
      const after = sql.exec<{ c: number }>("SELECT COUNT(*) AS c FROM tasks_fts").one().c;
      expect(after).toBe(before); // no churn — trigger ignored committed_order
    });
  });
});

describe("write-through RPC methods", () => {
  const seed = async (rows: Array<{ task_id: string; list_id?: string; title?: string }>) => {
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      for (const r of rows) {
        ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO tasks (task_id, list_id, status, title) VALUES (?, ?, 'notStarted', ?)",
          r.task_id,
          r.list_id ?? "L",
          r.title ?? "t",
        );
      }
    });
  };

  it("updateMyDayFields sets all four columns", async () => {
    await seed([{ task_id: "t1" }]);
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.updateMyDayFields("t1", {
        committed_day: "2026-05-27",
        committed_order: "2026-05-27T05:00:00Z",
        order_datetime: "2026-05-27T03:00:00Z",
        postponed_day: null,
      });
    });
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const row = ctx.storage.sql
        .exec<{
          committed_day: string | null;
          committed_order: string | null;
          order_datetime: string | null;
          postponed_day: string | null;
        }>(
          "SELECT committed_day, committed_order, order_datetime, postponed_day FROM tasks WHERE task_id='t1'",
        )
        .one();
      expect(row.committed_day).toBe("2026-05-27");
      expect(row.committed_order).toBe("2026-05-27T05:00:00Z");
      expect(row.order_datetime).toBe("2026-05-27T03:00:00Z");
      expect(row.postponed_day).toBeNull();
    });
  });

  it("updateMyDayFields with partial patch leaves untouched fields alone", async () => {
    await seed([{ task_id: "t2" }]);
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.updateMyDayFields("t2", {
        committed_day: "2026-05-27",
        committed_order: "2026-05-27T05:00:00Z",
        order_datetime: "2026-05-27T03:00:00Z",
        postponed_day: null,
      });
      await instance.updateMyDayFields("t2", { committed_order: "2026-05-27T06:00:00Z" });
    });
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const row = ctx.storage.sql
        .exec<{ committed_day: string | null; committed_order: string | null; order_datetime: string | null }>(
          "SELECT committed_day, committed_order, order_datetime FROM tasks WHERE task_id='t2'",
        )
        .one();
      expect(row.committed_day).toBe("2026-05-27");
      expect(row.committed_order).toBe("2026-05-27T06:00:00Z");
      expect(row.order_datetime).toBe("2026-05-27T03:00:00Z");
    });
  });

  it("clearMyDayFields nulls committed_day, committed_order, postponed_day; leaves order_datetime", async () => {
    await seed([{ task_id: "t3" }]);
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      await instance.updateMyDayFields("t3", {
        committed_day: "2026-05-27",
        committed_order: "2026-05-27T05:00:00Z",
        order_datetime: "2026-05-27T03:00:00Z",
        postponed_day: "2026-05-26",
      });
      await instance.clearMyDayFields("t3");
    });
    await runInDurableObject(stub(), async (_: TodoIndex, ctx) => {
      const row = ctx.storage.sql
        .exec<{
          committed_day: string | null;
          committed_order: string | null;
          order_datetime: string | null;
          postponed_day: string | null;
        }>(
          "SELECT committed_day, committed_order, order_datetime, postponed_day FROM tasks WHERE task_id='t3'",
        )
        .one();
      expect(row.committed_day).toBeNull();
      expect(row.committed_order).toBeNull();
      expect(row.postponed_day).toBeNull();
      expect(row.order_datetime).toBe("2026-05-27T03:00:00Z");
    });
  });

  it("updateMyDayFields is a no-op when the task is not in the index", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex) => {
      // Must not throw. The task may not be indexed yet; the next Graph delta
      // will add the row, and the next scan will fill the fields in.
      await instance.updateMyDayFields("never-indexed", { committed_day: "2026-05-27" });
    });
  });
});

describe("queryMyDayForDate", () => {
  it("returns rows committed to the date, ordered by committed_order DESC (nulls last) then order_datetime DESC", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      const insert = (id: string, day: string | null, co: string | null, od: string | null, postponed: string | null = null) =>
        ctx.storage.sql.exec(
          "INSERT INTO tasks (task_id, list_id, status, title, committed_day, committed_order, order_datetime, postponed_day) VALUES (?, 'L', 'notStarted', ?, ?, ?, ?, ?)",
          id, id, day, co, od, postponed,
        );
      insert("top",      "2026-05-27", "2026-05-27T06:00:00Z", "2026-05-01T00:00:00Z");
      insert("mid",      "2026-05-27", "2026-05-27T04:00:00Z", "2026-05-09T00:00:00Z");
      insert("legacy",   "2026-05-27", null,                    "2026-05-27T07:00:00Z");
      insert("other",    "2026-05-28", "2026-05-28T06:00:00Z", null);
      insert("not-mine", null,         null,                    null);

      const { rows } = await instance.queryMyDayForDate("2026-05-27");
      expect(rows.map((r) => r.task_id)).toEqual(["top", "mid", "legacy"]);
    });
  });

  it("excludes a task postponed to the same day (faithful to the app's filter)", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      ctx.storage.sql.exec(
        "INSERT INTO tasks (task_id, list_id, status, title, committed_day, committed_order, postponed_day) VALUES ('show', 'L', 'notStarted', 's', '2026-05-27', '2026-05-27T05:00:00Z', NULL)",
      );
      ctx.storage.sql.exec(
        "INSERT INTO tasks (task_id, list_id, status, title, committed_day, committed_order, postponed_day) VALUES ('hide', 'L', 'notStarted', 'h', '2026-05-27', '2026-05-27T06:00:00Z', '2026-05-27')",
      );
      const { rows } = await instance.queryMyDayForDate("2026-05-27");
      expect(rows.map((r) => r.task_id)).toEqual(["show"]);
    });
  });

  it("includes a task postponed to a different day", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      ctx.storage.sql.exec(
        "INSERT INTO tasks (task_id, list_id, status, title, committed_day, committed_order, postponed_day) VALUES ('t', 'L', 'notStarted', 't', '2026-05-27', '2026-05-27T05:00:00Z', '2026-05-26')",
      );
      const { rows } = await instance.queryMyDayForDate("2026-05-27");
      expect(rows.map((r) => r.task_id)).toEqual(["t"]);
    });
  });

  it("returns an empty result when nothing is committed to the date", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM tasks");
      const { rows } = await instance.queryMyDayForDate("2026-12-31");
      expect(rows).toEqual([]);
    });
  });
});

describe("getMyDayScanState", () => {
  it("returns nulls when the scan has never run", async () => {
    await runInDurableObject(stub(), async (instance: TodoIndex, ctx) => {
      ctx.storage.sql.exec("DELETE FROM sync_state WHERE resource = 'my_day_scan'");
      const state = await instance.getMyDayScanState();
      expect(state).toEqual({ last_scan_at_ms: null, status: null, last_error: null });
    });
  });
});

describe("isScanDue", () => {
  it("is true when there is no record of a prior scan", () => {
    expect(isScanDue(null, 60 * 60_000, 100)).toBe(true);
  });
  it("is true when the last scan is at least one window old", () => {
    const window = 60 * 60_000;
    expect(isScanDue(0, window, window)).toBe(true);
    expect(isScanDue(0, window, window + 1)).toBe(true);
  });
  it("is false within the window", () => {
    const window = 60 * 60_000;
    expect(isScanDue(100, window, 100 + window - 1)).toBe(false);
    expect(isScanDue(100, window, 100)).toBe(false);
  });
});
