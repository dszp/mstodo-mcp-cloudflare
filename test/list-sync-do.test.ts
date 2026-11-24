// Durable Object twin of test-node/list-sync.test.ts: the same checks on DO SQLite.
import { describe, it, expect } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { IndexCore } from "../src/core/index/index-core";
import { runListSyncChecks } from "./_list-sync-checks";

describe("list sync setting (Durable Object)", () => {
  it("records, excludes and re-includes lists", async () => {
    const stub = env.TODO_INDEX_DO.getByName("list-sync");
    await runInDurableObject(stub, async (_i, state) => {
      const c = new IndexCore({ sql: state.storage.sql, transact: (fn) => state.storage.transactionSync(fn), state: state.storage, alarms: state.storage, env: env as never });
      c.bootstrap();
      const r = await runListSyncChecks(c, env as never);
      // Re-including a list arms a sync cycle; this test doesn't run one.
      await state.storage.deleteAlarm();
      for (const [name, ok] of Object.entries(r)) expect([name, ok]).toEqual([name, true]);
    });
  });
});
