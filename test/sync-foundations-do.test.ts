// Durable Object twin of test-node/sync-foundations.test.ts: moveTask runs
// inside ctx.storage.transactionSync on the real DO SQLite (which also
// supports UPDATE ... FROM, used for the merge branch).
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "../src/core/index/index-core";

describe("IndexCore.moveTask on DO SQLite", () => {
  it("re-keys and merges inside one transaction", async () => {
    const stub = env.TODO_INDEX_DO.getByName("sync-foundations");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const t = (id: string, m: string) => ({ id, title: id, status: "notStarted", lastModifiedDateTime: m }) as never;
      c.upsertTask(t("a", "2026-11-23T10:00:00Z"), "L1");
      c.updateMyDayFields("a", { committed_day: "2026-11-23" });
      c.upsertTask(t("b", "2026-11-23T10:05:00Z"), "L2");
      c.moveTask("a", "L2", "b");
      const rows = state.storage.sql.exec("SELECT task_id, list_id, committed_day FROM tasks").toArray();
      expect(rows).toEqual([{ task_id: "b", list_id: "L2", committed_day: "2026-11-23" }]);
    });
  });
});
