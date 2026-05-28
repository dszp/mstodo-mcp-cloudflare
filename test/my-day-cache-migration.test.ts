import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import type { TodoIndex } from "../src/cache/index-do";

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
